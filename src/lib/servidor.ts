import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AssistenteIdSchema, type AssistenteId } from "./agente/assistentes";
import { criarGrafo, criarModeloOpenAI, novoTurno, type EstadoGrafo, type Grafo } from "./agente/grafo";

// Ponte entre HTTP e o grafo: valida as entradas, controla a concorrência por sessão
// e vincula a aprovação à proposta pendente guardada no servidor.

export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

export const MensagemSchema = z.object({
  assistente: AssistenteIdSchema.default("suporte"),
  sessaoId: z.uuid(),
  mensagem: z.string().trim().min(1).max(2000),
});

export const DecisaoHttpSchema = z.object({
  assistente: AssistenteIdSchema.default("suporte"),
  sessaoId: z.uuid(),
  propostaId: z.string().min(1),
  decisao: z.enum(["aprovar", "rejeitar"]),
});

// ---- Visão devolvida à tela (sem objetos internos do LangChain) ----

export type ItemConversa =
  | { tipo: "usuario" | "assistente"; texto: string }
  | { tipo: "chamada"; ferramenta: string; args: unknown }
  | { tipo: "resultado"; ferramenta: string; ok: boolean; codigo?: string };

export type VisaoSessao = {
  assistente: AssistenteId;
  sessaoId: string;
  itens: ItemConversa[];
  proposta: { propostaId: string; ferramenta: string; args: Record<string, unknown> } | null;
  erro: { codigo: string; mensagem: string } | null;
};

function paraItens(mensagens: BaseMessage[]): ItemConversa[] {
  return mensagens.flatMap((m): ItemConversa[] => {
    if (HumanMessage.isInstance(m)) return [{ tipo: "usuario", texto: String(m.content) }];
    if (ToolMessage.isInstance(m)) {
      const r = JSON.parse(String(m.content)) as { ok: boolean; erro?: { codigo: string } };
      return [{ tipo: "resultado", ferramenta: m.name ?? "", ok: r.ok, codigo: r.erro?.codigo }];
    }
    if (AIMessage.isInstance(m)) {
      const chamadas = (m.tool_calls ?? []).map((c) => ({ tipo: "chamada" as const, ferramenta: c.name, args: c.args }));
      const texto = String(m.content ?? "").trim();
      return texto ? [...chamadas, { tipo: "assistente", texto }] : chamadas;
    }
    return [];
  });
}

function paraVisao(assistente: AssistenteId, sessaoId: string, estado: Partial<EstadoGrafo>): VisaoSessao {
  const p = estado.propostaPendente;
  return {
    assistente,
    sessaoId,
    itens: paraItens(estado.messages ?? []),
    proposta: p ? { propostaId: p.propostaId, ferramenta: p.ferramenta, args: p.args } : null,
    erro: estado.erro ?? null,
  };
}

// ---- Serviço ----

export function criarServico(grafo: Grafo) {
  const ocupadas = new Set<string>();

  // Histórico separado por assistente E sessão: cada par vira um thread_id próprio no checkpoint.
  // O assistente vai também em configurable, de onde o grafo lê prompt e ferramentas permitidas.
  const threadId = (assistente: AssistenteId, sessaoId: string) => `${assistente}:${sessaoId}`;
  const config = (assistente: AssistenteId, sessaoId: string) => ({
    configurable: { thread_id: threadId(assistente, sessaoId), assistente },
  });

  // Correlação no LangSmith: thread_id agrupa a conversa (aba "Threads"); execucao_id liga o turno
  // à sua retomada após a aprovação, que é outra requisição HTTP e, portanto, outro rastro raiz.
  const rastreio = (assistente: AssistenteId, sessaoId: string, execucaoId: string, runName: string) => ({
    ...config(assistente, sessaoId),
    runName,
    tags: ["aurora", assistente],
    metadata: { thread_id: threadId(assistente, sessaoId), sessao_id: sessaoId, assistente, execucao_id: execucaoId },
  });

  // Uma requisição por vez por conversa. add() acontece antes de qualquer await, então não há corrida.
  async function exclusivo<T>(chave: string, fn: () => Promise<T>): Promise<T> {
    if (ocupadas.has(chave)) throw new ErroHttp(409, "Sessão ocupada: aguarde a resposta anterior.");
    ocupadas.add(chave);
    try {
      return await fn();
    } finally {
      ocupadas.delete(chave);
    }
  }

  async function estadoAtual(assistente: AssistenteId, sessaoId: string) {
    return (await grafo.getState(config(assistente, sessaoId))).values as Partial<EstadoGrafo>;
  }

  return {
    async verSessao(sessaoId: string, assistente: AssistenteId = "suporte") {
      return paraVisao(assistente, sessaoId, await estadoAtual(assistente, sessaoId));
    },

    enviarMensagem(sessaoId: string, mensagem: string, assistente: AssistenteId = "suporte") {
      return exclusivo(threadId(assistente, sessaoId), async () => {
        if ((await estadoAtual(assistente, sessaoId)).propostaPendente) {
          throw new ErroHttp(409, "Há uma proposta aguardando decisão. Aprove ou rejeite antes de continuar.");
        }
        const execucaoId = randomUUID();
        const r = await grafo.invoke(novoTurno(mensagem, execucaoId), rastreio(assistente, sessaoId, execucaoId, "turno"));
        return paraVisao(assistente, sessaoId, r);
      });
    },

    // A decisão só retoma o grafo se for da proposta pendente NESTA conversa.
    // Repetir depois de decidido cai aqui com 409: nada é executado de novo.
    decidir(sessaoId: string, propostaId: string, aprovado: boolean, assistente: AssistenteId = "suporte") {
      return exclusivo(threadId(assistente, sessaoId), async () => {
        const estado = await estadoAtual(assistente, sessaoId);
        const pendente = estado.propostaPendente;
        if (!pendente || pendente.propostaId !== propostaId) {
          throw new ErroHttp(409, "Não há proposta pendente com este id (já decidida ou inexistente). Nada foi executado.");
        }
        const nome = aprovado ? "retomada (aprovado)" : "retomada (rejeitado)";
        const r = await grafo.invoke(
          new Command({ resume: { propostaId, aprovado } }),
          rastreio(assistente, sessaoId, estado.execucaoId ?? "", nome),
        );
        return paraVisao(assistente, sessaoId, r);
      });
    },
  };
}

export type Servico = ReturnType<typeof criarServico>;

// ponytail: singleton em globalThis para o MemorySaver sobreviver ao hot reload do Next em dev.
const global_ = globalThis as typeof globalThis & { __aurora?: Servico };
export function servico(): Servico {
  return (global_.__aurora ??= criarServico(criarGrafo({ modelo: criarModeloOpenAI() })));
}

/** Converte o resultado (ou o erro) em resposta HTTP, sem vazar detalhes internos. */
export async function responder(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    if (e instanceof ErroHttp) return Response.json({ erro: e.message }, { status: e.status });
    if (e instanceof z.ZodError) return Response.json({ erro: z.prettifyError(e) }, { status: 400 });
    if (e instanceof SyntaxError) return Response.json({ erro: "JSON inválido." }, { status: 400 });
    console.error("[aurora] erro inesperado:", e);
    return Response.json({ erro: "Erro interno." }, { status: 500 });
  }
}
