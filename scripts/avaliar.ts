// Avaliação no LangSmith: cria/atualiza o dataset e roda os experimentos.
//  1. modelo real (OPENAI_MODEL, padrão gpt-4o-mini), 3 repetições por caso;
//  2. controles negativos com modelos sabotados, para mostrar o avaliador reprovando no LangSmith.
// Uso: npm run avaliar   (requer OPENAI_API_KEY e LANGSMITH_* no .env.local)
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { AIMessage } from "@langchain/core/messages";
import { Client } from "langsmith";
import { evaluate, type EvaluationResult } from "langsmith/evaluation";
import { randomUUID } from "node:crypto";
import { criarGrafo, criarModeloOpenAI, novoTurno, type ModeloComFerramentas } from "../src/lib/agente/grafo";
import { CASOS, NOME_DATASET, avaliar, extrairExecucoes, type Referencia, type SaidaAvaliada } from "../src/lib/avaliacao/avaliador";

const client = new Client();
const MODELO = process.env.OPENAI_MODEL || "gpt-4o-mini";

/** Cria o dataset se não existir e acrescenta casos que faltarem (idempotente, chave = metadata.caso). */
async function garantirDataset() {
  const dataset = (await client.hasDataset({ datasetName: NOME_DATASET }))
    ? await client.readDataset({ datasetName: NOME_DATASET })
    : await client.createDataset(NOME_DATASET, {
        description: "Assistente Aurora: caso obrigatório do desafio + caso próprio (escalonar chamado resolvido).",
      });
  const existentes = new Set<string>();
  for await (const ex of client.listExamples({ datasetId: dataset.id })) existentes.add(String(ex.metadata?.caso));
  const faltando = CASOS.filter((c) => !existentes.has(c.caso));
  if (faltando.length) {
    await client.createExamples(
      faltando.map((c) => ({ dataset_id: dataset.id, inputs: { pergunta: c.pergunta }, outputs: c.referencia, metadata: { caso: c.caso } })),
    );
  }
  console.log(`Dataset "${NOME_DATASET}": ${existentes.size + faltando.length} casos (${faltando.length} novos).`);
  return dataset;
}

/** Alvo avaliado: roda o MESMO grafo da aplicação numa sessão nova e devolve o que foi executado. */
function alvo(criarModelo: () => ModeloComFerramentas) {
  return async (inputs: Record<string, any>): Promise<SaidaAvaliada & { modeloResolvido: string }> => {
    const sessao = randomUUID();
    const grafo = criarGrafo({ modelo: criarModelo() });
    const estado = await grafo.invoke(novoTurno(inputs.pergunta), {
      configurable: { thread_id: sessao },
      metadata: { thread_id: sessao },
    });
    const resolvido = estado.messages.find((m) => AIMessage.isInstance(m) && m.response_metadata?.model_name);
    return {
      resposta: String(estado.messages.at(-1)?.content ?? ""),
      execucoes: extrairExecucoes(estado.messages),
      propostaGerada: estado.propostaPendente !== null,
      modeloResolvido: String((resolvido as AIMessage | undefined)?.response_metadata?.model_name ?? "dublê"),
    };
  };
}

const avaliador = ({ outputs, referenceOutputs }: { outputs: Record<string, any>; referenceOutputs?: Record<string, any> }) => ({
  results: avaliar(outputs as SaidaAvaliada, referenceOutputs as Referencia) as EvaluationResult[],
});

// Modelos sabotados (controle negativo): provam que o avaliador reprova.
const pulaConsulta = (): ModeloComFerramentas => ({
  invoke: async () => new AIMessage("Os chamados abertos são CH-101 e CH-103."),
});
const inventaChamado = (): ModeloComFerramentas => {
  const roteiro = [
    new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "listar_chamados", args: { situacao: "aberto" }, type: "tool_call" }] }),
    new AIMessage("Os chamados abertos são CH-101, CH-103 e CH-999."),
  ];
  return { invoke: async () => roteiro.shift() ?? new AIMessage("") };
};

async function experimento(nome: string, criarModelo: () => ModeloComFerramentas, data: any, extra: Record<string, unknown>) {
  const r = await evaluate(alvo(criarModelo), {
    data,
    evaluators: [avaliador],
    experimentPrefix: nome,
    maxConcurrency: 2,
    ...extra,
  });
  console.log(`\n■ ${r.experimentName}`);
  for (const linha of r.results) {
    const notas = Object.fromEntries(linha.evaluationResults.results.map((n) => [n.key, n.score]));
    const falhas = linha.evaluationResults.results.filter((n) => n.score === 0 && n.key !== "aprovado").map((n) => `${n.key}: ${n.comment}`);
    console.log(`  ${notas.aprovado === 1 ? "✅" : "❌"} ${linha.example.metadata?.caso}${falhas.length ? "  → " + falhas.join(" | ") : ""}`);
  }
}

const dataset = await garantirDataset();

await experimento(`real-${MODELO}`, criarModeloOpenAI, NOME_DATASET, {
  numRepetitions: 3,
  description: `Modelo real ${MODELO} (temperature 0, parallel_tool_calls false), mesmo grafo e executor da aplicação.`,
  metadata: { tipo: "modelo-real", modelo: MODELO, temperatura: 0, parallel_tool_calls: false },
});

const obrigatorio: any[] = [];
for await (const ex of client.listExamples({ datasetId: dataset.id })) {
  if (ex.metadata?.caso === "obrigatorio-listar-abertos") obrigatorio.push(ex);
}
await experimento("controle-negativo-pula-consulta", pulaConsulta, obrigatorio, {
  description: "Dublê que responde CH-101 e CH-103 SEM chamar a ferramenta. Esperado: reprovado.",
  metadata: { tipo: "controle-negativo" },
});
await experimento("controle-negativo-inventa-chamado", inventaChamado, obrigatorio, {
  description: "Dublê que chama listar_chamados mas inventa o CH-999 na resposta. Esperado: reprovado.",
  metadata: { tipo: "controle-negativo" },
});

await awaitAllCallbacks();
