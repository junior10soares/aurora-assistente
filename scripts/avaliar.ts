// Avaliação no LangSmith: cria/atualiza os datasets e roda os experimentos.
//  Núcleo (dataset "aurora-avaliacao"):
//    1. modelo real (OPENAI_MODEL, padrão gpt-4o-mini), 3 repetições por caso;
//    2. controles negativos com modelos sabotados, para mostrar o avaliador reprovando no LangSmith.
//  Bônus (dataset "aurora-assistentes"):
//    3. modelo real nos dois assistentes, 2 repetições por caso;
//    4. dublê adversário que insiste em ferramentas proibidas: o backend precisa manter tudo aprovado.
// Uso: npm run avaliar            (tudo; requer OPENAI_API_KEY e LANGSMITH_* no .env.local)
//      npm run avaliar -- nucleo  (só o núcleo)   |   npm run avaliar -- bonus  (só o bônus)
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Client } from "langsmith";
import { evaluate, type EvaluationResult } from "langsmith/evaluation";
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import { criarGrafo, criarModeloOpenAI, novoTurno, type ModeloComFerramentas } from "../src/lib/agente/grafo";
import {
  CASOS,
  CASOS_ASSISTENTES,
  NOME_DATASET,
  NOME_DATASET_ASSISTENTES,
  avaliar,
  extrairExecucoes,
  type Referencia,
  type SaidaAvaliada,
} from "../src/lib/avaliacao/avaliador";

const client = new Client();
const MODELO = process.env.OPENAI_MODEL || "gpt-4o-mini";
const parte = process.argv[2];

type Caso = { caso: string; pergunta: string; referencia: Referencia; assistente?: string; antes?: string[]; decisao?: boolean };

/** Cria o dataset se não existir e acrescenta casos que faltarem (idempotente, chave = metadata.caso). */
async function garantirDataset(nome: string, descricao: string, casos: Caso[]) {
  const dataset = (await client.hasDataset({ datasetName: nome }))
    ? await client.readDataset({ datasetName: nome })
    : await client.createDataset(nome, { description: descricao });
  const existentes = new Set<string>();
  for await (const ex of client.listExamples({ datasetId: dataset.id })) existentes.add(String(ex.metadata?.caso));
  const faltando = casos.filter((c) => !existentes.has(c.caso));
  if (faltando.length) {
    await client.createExamples(
      faltando.map((c) => ({
        dataset_id: dataset.id,
        inputs: { pergunta: c.pergunta, assistente: c.assistente ?? "suporte", antes: c.antes ?? [], decisao: c.decisao ?? null },
        outputs: c.referencia,
        metadata: { caso: c.caso },
      })),
    );
  }
  console.log(`Dataset "${nome}": ${existentes.size + faltando.length} casos (${faltando.length} novos).`);
  return dataset;
}

async function exemplos(datasetId: string, filtro: (caso: string) => boolean) {
  const lista: any[] = [];
  for await (const ex of client.listExamples({ datasetId })) if (filtro(String(ex.metadata?.caso))) lista.push(ex);
  return lista;
}

/** Alvo avaliado: roda o MESMO grafo da aplicação, no assistente do exemplo, numa sessão nova. */
function alvo(criarModelo: (inputs: Record<string, any>) => ModeloComFerramentas) {
  return async (inputs: Record<string, any>): Promise<SaidaAvaliada & { modeloResolvido: string }> => {
    const assistente = inputs.assistente ?? "suporte";
    const sessao = `${assistente}:${randomUUID()}`;
    const grafo = criarGrafo({ modelo: criarModelo(inputs) });
    const config = { configurable: { thread_id: sessao, assistente }, metadata: { thread_id: sessao, assistente } };
    // Turnos anteriores (contexto da conversa), quando o caso pede.
    for (const anterior of inputs.antes ?? []) await grafo.invoke(novoTurno(anterior), config);
    let estado = await grafo.invoke(novoTurno(inputs.pergunta), config);
    // Decisão humana simulada (quando o caso pede): retoma com a proposta EXATA que ficou pendente.
    if (typeof inputs.decisao === "boolean" && estado.propostaPendente) {
      const resume = { propostaId: estado.propostaPendente.propostaId, aprovado: inputs.decisao };
      estado = await grafo.invoke(new Command({ resume }), config);
    }
    // Avalia só o turno da pergunta: do último HumanMessage em diante.
    const inicio = estado.messages.findLastIndex((m) => HumanMessage.isInstance(m));
    const turno = estado.messages.slice(inicio);
    const resolvido = turno.find((m) => AIMessage.isInstance(m) && m.response_metadata?.model_name);
    const p = estado.propostaPendente;
    return {
      resposta: String(turno.at(-1)?.content ?? ""),
      execucoes: extrairExecucoes(turno),
      propostaGerada: p !== null,
      proposta: p ? { ferramenta: p.ferramenta, args: p.args } : null,
      modeloResolvido: String((resolvido as AIMessage | undefined)?.response_metadata?.model_name ?? "dublê"),
    };
  };
}

const avaliador = ({ outputs, referenceOutputs }: { outputs: Record<string, any>; referenceOutputs?: Record<string, any> }) => ({
  results: avaliar(outputs as SaidaAvaliada, referenceOutputs as Referencia) as EvaluationResult[],
});

const roteiro = (...respostas: AIMessage[]): ModeloComFerramentas => ({ invoke: async () => respostas.shift() ?? new AIMessage("") });
const pedir = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `c_${name}`, name, args, type: "tool_call" }] });

// Modelos sabotados (controle negativo): provam que o avaliador reprova.
const pulaConsulta = () => roteiro(new AIMessage("Os chamados abertos são CH-101 e CH-103."));
const inventaChamado = () =>
  roteiro(pedir("listar_chamados", { situacao: "aberto" }), new AIMessage("Os chamados abertos são CH-101, CH-103 e CH-999."));

// Dublê adversário: cada assistente insiste na ferramenta do OUTRO. Quem barra é o executor.
const adversario = (inputs: Record<string, any>) =>
  inputs.assistente === "viagens"
    ? roteiro(pedir("consultar_chamado", { id: "CH-101" }), new AIMessage("(dublê) tentei consultar o chamado."))
    : roteiro(pedir("call_rag", { pergunta: "Documentos para a França", pais: "França" }), new AIMessage("(dublê) tentei o RAG."));

async function experimento(nome: string, criarModelo: (inputs: Record<string, any>) => ModeloComFerramentas, data: any, extra: Record<string, unknown>) {
  const r = await evaluate(alvo(criarModelo), { data, evaluators: [avaliador], experimentPrefix: nome, maxConcurrency: 2, ...extra });
  console.log(`\n■ ${r.experimentName}`);
  for (const linha of r.results) {
    const notas = Object.fromEntries(linha.evaluationResults.results.map((n) => [n.key, n.score]));
    const falhas = linha.evaluationResults.results.filter((n) => n.score === 0 && n.key !== "aprovado").map((n) => `${n.key}: ${n.comment}`);
    console.log(`  ${notas.aprovado === 1 ? "✅" : "❌"} ${linha.example.metadata?.caso}${falhas.length ? "  → " + falhas.join(" | ") : ""}`);
  }
}

const configuracao = { modelo: MODELO, temperatura: 0, parallel_tool_calls: false };

if (parte !== "bonus") {
  const dataset = await garantirDataset(
    NOME_DATASET,
    "Assistente Aurora: caso obrigatório do desafio + caso próprio (escalonar chamado resolvido).",
    CASOS,
  );
  await experimento(`real-${MODELO}`, criarModeloOpenAI, NOME_DATASET, {
    numRepetitions: 3,
    description: `Modelo real ${MODELO} (temperature 0, parallel_tool_calls false), mesmo grafo e executor da aplicação.`,
    metadata: { tipo: "modelo-real", ...configuracao },
  });
  const obrigatorio = await exemplos(dataset.id, (c) => c === "obrigatorio-listar-abertos");
  await experimento("controle-negativo-pula-consulta", pulaConsulta, obrigatorio, {
    description: "Dublê que responde CH-101 e CH-103 SEM chamar a ferramenta. Esperado: reprovado.",
    metadata: { tipo: "controle-negativo" },
  });
  await experimento("controle-negativo-inventa-chamado", inventaChamado, obrigatorio, {
    description: "Dublê que chama listar_chamados mas inventa o CH-999 na resposta. Esperado: reprovado.",
    metadata: { tipo: "controle-negativo" },
  });
}

if (parte !== "nucleo") {
  const dataset = await garantirDataset(
    NOME_DATASET_ASSISTENTES,
    "Bônus: assistentes Suporte e Viagens no mesmo grafo (RAG com fonte, sem evidência e restrição de ferramentas).",
    CASOS_ASSISTENTES,
  );
  await experimento(`assistentes-real-${MODELO}`, criarModeloOpenAI, NOME_DATASET_ASSISTENTES, {
    numRepetitions: 2,
    description: `Modelo real ${MODELO} nos dois assistentes, mesmo grafo configurado em execução.`,
    metadata: { tipo: "modelo-real", ...configuracao },
  });
  const restritos = await exemplos(dataset.id, (c) => c.includes("tenta"));
  await experimento("assistentes-adversario-backend", adversario, restritos, {
    description: "Dublê que insiste na ferramenta do outro assistente. Esperado: aprovado, porque o executor recusa.",
    metadata: { tipo: "adversario" },
  });
}

await awaitAllCallbacks();
