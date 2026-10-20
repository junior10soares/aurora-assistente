import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, MemorySaver, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { executarFerramenta, exigeAprovacao, prepararProposta, type ErroExecucao, type Proposta, type ResultadoFerramenta } from "./executor";
import { assistenteDe, definicoes, type DefinicaoFerramenta } from "./assistentes";
import { type Escalonamento } from "./ferramentas";

// ---- Limites de uma execução (um turno do usuário, incluindo a retomada após aprovação) ----

export const LIMITES_EXECUCAO = {
  maxPassosModelo: 8, // chamadas ao modelo por execução (evita laço infinito)
  tempoAtivoMaxMs: 60_000, // soma do tempo DENTRO dos nós; a espera humana não entra
  timeoutModeloMs: 20_000, // tempo máximo de uma chamada ao modelo
};
export type LimitesExecucao = typeof LIMITES_EXECUCAO;

// A proposta guarda também o id da chamada do modelo, para responder a ela após a decisão humana.
export type PropostaPendente = Proposta & { toolCallId: string };

// ---- Estado ----

const ultimo = <T>(padrao: () => T) => Annotation<T>({ reducer: (_, novo) => novo, default: padrao });

export const Estado = Annotation.Root({
  ...MessagesAnnotation.spec, // histórico da conversa (as novas mensagens são acrescentadas)
  execucaoId: ultimo<string>(() => ""),
  passos: ultimo<number>(() => 0),
  tempoAtivoMs: ultimo<number>(() => 0),
  propostaPendente: ultimo<PropostaPendente | null>(() => null),
  erro: ultimo<ErroExecucao | null>(() => null),
});
export type EstadoGrafo = typeof Estado.State;

/** Entrada de um novo turno do usuário: zera os contadores da execução. */
export function novoTurno(texto: string, execucaoId: string = randomUUID()): Partial<typeof Estado.Update> {
  return {
    messages: [new HumanMessage(texto)],
    execucaoId,
    passos: 0,
    tempoAtivoMs: 0,
    erro: null,
  };
}

// O que o humano devolve ao retomar. Validado aqui também (além da API): defesa em profundidade.
export const DecisaoSchema = z.object({ propostaId: z.string().min(1), aprovado: z.boolean() });
export type Decisao = z.infer<typeof DecisaoSchema>;

// ---- Modelo ----

// O grafo só precisa de "algo com invoke". Recebe as ferramentas do assistente da execução para vinculá-las.
// Na aplicação é o ChatOpenAI; nos testes, um modelo falso (que pode ignorar as ferramentas).
export type ModeloComFerramentas = {
  invoke(mensagens: BaseMessage[], config: RunnableConfig, ferramentas: DefinicaoFerramenta[]): Promise<AIMessage>;
};

export function criarModeloOpenAI(): ModeloComFerramentas {
  const base = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    maxRetries: 2, // novas tentativas em falhas transitórias da API
  });
  // Um modelo vinculado por conjunto de ferramentas (um por assistente), criado sob demanda.
  const vinculados = new Map<string, { invoke(m: BaseMessage[], c: RunnableConfig): Promise<AIMessage> }>();
  return {
    invoke(mensagens, config, ferramentas) {
      const chave = ferramentas.map((f) => f.name).join(",");
      if (!vinculados.has(chave)) vinculados.set(chave, base.bindTools(ferramentas, { parallel_tool_calls: false }));
      return vinculados.get(chave)!.invoke(mensagens, config);
    },
  };
}

// ---- Grafo ----

function encerrarComErro(codigo: string, mensagem: string) {
  return { erro: { codigo, mensagem }, messages: [new AIMessage(`Não foi possível concluir a solicitação: ${mensagem}`)] };
}

export function criarGrafo(opcoes: {
  modelo: ModeloComFerramentas;
  checkpointer?: MemorySaver;
  limites?: Partial<LimitesExecucao>;
}) {
  const limites = { ...LIMITES_EXECUCAO, ...opcoes.limites };

  // Nó 1: chama o modelo (se ainda houver orçamento de passos e de tempo).
  async function agente(estado: EstadoGrafo, config: RunnableConfig) {
    const assistente = assistenteDe(config);
    if (estado.passos >= limites.maxPassosModelo) {
      return encerrarComErro("LIMITE_PASSOS", `limite de ${limites.maxPassosModelo} passos do modelo atingido.`);
    }
    const restanteMs = limites.tempoAtivoMaxMs - estado.tempoAtivoMs;
    if (restanteMs <= 0) {
      return encerrarComErro("LIMITE_TEMPO", `limite de ${limites.tempoAtivoMaxMs} ms de execução ativa atingido.`);
    }

    const inicio = performance.now();
    const base = { passos: estado.passos + 1 };
    try {
      const resposta = await opcoes.modelo.invoke(
        [new SystemMessage(assistente.prompt), ...estado.messages],
        {
          ...config,
          // AbortSignal.timeout exige inteiro; o tempo restante é fracionário (performance.now()).
          signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(limites.timeoutModeloMs, restanteMs)))),
        },
        definicoes(assistente.ferramentas), // o modelo só VÊ as ferramentas do seu assistente
      );
      return { ...base, tempoAtivoMs: estado.tempoAtivoMs + (performance.now() - inicio), messages: [resposta] };
    } catch (e) {
      // O usuário recebe mensagem genérica; o detalhe fica no log do servidor (e no rastro do LangSmith).
      console.error("[aurora] falha ao chamar o modelo:", e);
      return {
        ...base,
        tempoAtivoMs: estado.tempoAtivoMs + (performance.now() - inicio),
        ...encerrarComErro("FALHA_MODELO", "o modelo não respondeu (erro ou tempo esgotado)."),
      };
    }
  }

  // Nó 2: executor. Leitura executa; escrita vira proposta (não executa).
  async function ferramentas(estado: EstadoGrafo, config: RunnableConfig) {
    // ...e o executor só ACEITA as ferramentas do seu assistente (restrição no backend).
    const permitidas = assistenteDe(config).ferramentas;
    const inicio = performance.now();
    const ultima = estado.messages.at(-1) as AIMessage;
    const respostas: ToolMessage[] = [];
    let propostaPendente: PropostaPendente | null = null;

    // Chamadas com JSON malformado: o modelo recebe o erro e pode corrigir (até o limite de passos).
    for (const invalida of ultima.invalid_tool_calls ?? []) {
      const erro = { codigo: "ENTRADA_INVALIDA", mensagem: "Argumentos malformados (JSON inválido)." };
      respostas.push(resposta(invalida.id ?? "", invalida.name ?? "desconhecida", { ok: false, erro }));
    }

    for (const chamada of ultima.tool_calls ?? []) {
      const id = chamada.id ?? "";
      if (exigeAprovacao(chamada.name)) {
        if (propostaPendente) {
          const erro = { codigo: "UMA_PROPOSTA_POR_VEZ", mensagem: "Já existe uma proposta aguardando aprovação." };
          respostas.push(resposta(id, chamada.name, { ok: false, erro }));
          continue;
        }
        const p = await prepararProposta(chamada.name, chamada.args, permitidas);
        // Proposta válida: a resposta a esta chamada só é gerada depois da decisão humana.
        if (p.ok) propostaPendente = { ...p.proposta, toolCallId: id };
        else respostas.push(resposta(id, chamada.name, p));
      } else {
        const prazo = inicio + limites.tempoAtivoMaxMs - estado.tempoAtivoMs; // orçamento restante do turno
        respostas.push(resposta(id, chamada.name, await executarFerramenta(chamada.name, chamada.args, { permitidas, prazo })));
      }
    }

    return {
      messages: respostas,
      propostaPendente,
      tempoAtivoMs: estado.tempoAtivoMs + (performance.now() - inicio),
    };
  }

  // Nó 3: pausa para decisão humana. Na retomada, o nó roda de novo e interrupt() devolve a decisão.
  async function aprovacao(estado: EstadoGrafo, config: RunnableConfig) {
    const proposta = estado.propostaPendente!;
    const decisao = DecisaoSchema.safeParse(interrupt({ tipo: "aprovacao", proposta }));

    const inicio = performance.now();
    const vinculada = decisao.success && decisao.data.propostaId === proposta.propostaId;
    // Rastro explícito da decisão humana (só acontece na retomada; na 1ª passada o interrupt já parou o nó).
    await traceable(async (_d: object) => ({ vinculada, aprovado: vinculada && decisao.data.aprovado }), {
      name: "decisao_humana",
    })({ propostaPendente: proposta.propostaId, decisaoRecebida: decisao.success ? decisao.data : "inválida" });
    if (!vinculada || !decisao.data.aprovado) {
      const motivo = vinculada ? "Rejeitado pela pessoa revisora." : "Decisão inválida ou de outra proposta.";
      return {
        propostaPendente: null,
        messages: [
          resposta(proposta.toolCallId, proposta.ferramenta, {
            ok: false,
            erro: { codigo: "REJEITADO", mensagem: `${motivo} Nada foi registrado.` },
          }),
          new AIMessage("Escalonamento não aprovado. Nada foi registrado."),
        ],
      };
    }

    // Aprovado: executa EXATAMENTE os args da proposta exibida, com o propostaId como chave de idempotência.
    const resultado = await executarFerramenta(proposta.ferramenta, proposta.args, {
      aprovacao: { propostaId: proposta.propostaId },
      permitidas: assistenteDe(config).ferramentas,
      prazo: inicio + limites.tempoAtivoMaxMs - estado.tempoAtivoMs,
    });
    return {
      propostaPendente: null,
      messages: [resposta(proposta.toolCallId, proposta.ferramenta, resultado), new AIMessage(confirmacao(resultado))],
      tempoAtivoMs: estado.tempoAtivoMs + (performance.now() - inicio),
    };
  }

  // Funções de roteamento nomeadas: aparecem com esses nomes no rastro do LangSmith.
  function rota_apos_agente(e: EstadoGrafo) {
    const ultima = e.messages.at(-1);
    const pediuFerramenta =
      !e.erro && AIMessage.isInstance(ultima) && Boolean(ultima.tool_calls?.length || ultima.invalid_tool_calls?.length);
    return pediuFerramenta ? "ferramentas" : END;
  }
  function rota_apos_ferramentas(e: EstadoGrafo) {
    return e.propostaPendente ? "aprovacao" : "agente";
  }

  return new StateGraph(Estado)
    .addNode("agente", agente)
    .addNode("ferramentas", ferramentas)
    .addNode("aprovacao", aprovacao)
    .addEdge(START, "agente")
    .addConditionalEdges("agente", rota_apos_agente, ["ferramentas", END])
    .addConditionalEdges("ferramentas", rota_apos_ferramentas, ["aprovacao", "agente"])
    // Após a decisão humana o modelo não fala mais: a mensagem final vem do código (ver confirmacao()).
    .addEdge("aprovacao", END)
    .compile({ checkpointer: opcoes.checkpointer ?? new MemorySaver() });
}

export type Grafo = ReturnType<typeof criarGrafo>;

// Mensagem final montada a partir do retorno REAL do registro: o modelo não pode confirmar o que não ocorreu.
function confirmacao(resultado: ResultadoFerramenta): string {
  if (!resultado.ok) return `Não foi possível registrar o escalonamento: ${resultado.erro.mensagem} Nada foi registrado.`;
  const { escalonamento, jaRegistrado } = resultado.dados as { escalonamento: Escalonamento; jaRegistrado: boolean };
  return jaRegistrado
    ? `Este escalonamento já estava registrado como ${escalonamento.id} (chamado ${escalonamento.chamadoId}). Nenhum registro duplicado foi criado.`
    : `Escalonamento ${escalonamento.id} registrado para o chamado ${escalonamento.chamadoId} após aprovação humana.`;
}

function resposta(toolCallId: string, nome: string, conteudo: unknown) {
  return new ToolMessage({ tool_call_id: toolCallId, name: nome, content: JSON.stringify(conteudo) });
}
