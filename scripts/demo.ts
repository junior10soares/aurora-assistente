// Gera, com o modelo real, os rastros usados na apresentação (fluxo completo, aprovação, rejeição,
// falha recuperada, falha esgotada, CH-102 bloqueado, chamado inexistente).
// Uso: npm run demo            (todos os cenários; requer OPENAI_API_KEY e LANGSMITH_* no .env.local)
//      npm run demo -- viagens  (só os cenários cujo nome contém "viagens")
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { AIMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { simularFalhas } from "../src/lib/agente/executor";
import { criarGrafo, criarModeloOpenAI, type ModeloComFerramentas } from "../src/lib/agente/grafo";
import { criarServico, type VisaoSessao } from "../src/lib/servidor";

const servico = criarServico(criarGrafo({ modelo: criarModeloOpenAI() }));
const filtro = process.argv[2]?.toLowerCase();
const resumo: { cenario: string; sessao: string; resultado: string }[] = [];

const ultimaResposta = (v: VisaoSessao) => {
  const item = [...v.itens].reverse().find((i) => i.tipo === "assistente");
  return item && "texto" in item ? item.texto.replace(/\s+/g, " ").slice(0, 400) : "";
};

async function cenario(nome: string, passos: (sessao: string) => Promise<string>) {
  if (filtro && !nome.toLowerCase().includes(filtro)) return;
  const sessao = randomUUID();
  process.stdout.write(`▶ ${nome}... `);
  try {
    const resultado = await passos(sessao);
    resumo.push({ cenario: nome, sessao, resultado });
    console.log("ok");
  } catch (e) {
    resumo.push({ cenario: nome, sessao, resultado: `ERRO: ${(e as Error).message}` });
    console.log("falhou");
  }
}

await cenario("1. Fluxo completo: consulta → proposta → aprovação → registro", async (s) => {
  const v = await servico.enviarMensagem(s, "Consulte o CH-101 e prepare um escalonamento se ele estiver aberto.");
  if (!v.proposta) return `sem proposta: ${ultimaResposta(v)}`;
  const final = await servico.decidir(s, v.proposta.propostaId, true);
  // Aprovação repetida: deve ser recusada sem executar nada.
  const repetida = await servico.decidir(s, v.proposta.propostaId, true).then(
    () => "aceita (ERRADO)",
    (e: Error) => `recusada (${e.message.slice(0, 40)}…)`,
  );
  return `${ultimaResposta(final)} | aprovação repetida: ${repetida}`;
});

await cenario("2. Rejeição: nada é registrado", async (s) => {
  const v = await servico.enviarMensagem(s, "Escalone o CH-103: o relatório está duplicando valores e o cliente vai fechar o mês.");
  if (!v.proposta) return `sem proposta: ${ultimaResposta(v)}`;
  return ultimaResposta(await servico.decidir(s, v.proposta.propostaId, false));
});

await cenario("3. Falha transitória recuperada (2 falhas, sucesso na 3ª tentativa)", async (s) => {
  simularFalhas("listar_chamados", "transitoria", "transitoria");
  return ultimaResposta(await servico.enviarMensagem(s, "Liste todos os chamados abertos."));
});

await cenario("4. Falha esgotada (3 timeouts): erro controlado, nada inventado", async (s) => {
  simularFalhas("consultar_chamado", "lenta", "lenta", "lenta");
  return ultimaResposta(await servico.enviarMensagem(s, "Qual a situação do CH-103?"));
});

await cenario("5. CH-102 resolvido: escalonamento bloqueado", async (s) => {
  const v = await servico.enviarMensagem(s, "Escalone o CH-102, o cliente está reclamando.");
  return v.proposta ? "PROPOSTA GERADA (ERRADO)" : ultimaResposta(v);
});

await cenario("6. Chamado inexistente", async (s) => {
  return ultimaResposta(await servico.enviarMensagem(s, "Consulte o CH-999."));
});

// ---- Bônus: assistentes (mesmo grafo, configuração em execução) ----

/** Dublê "adversário": insiste em pedir uma ferramenta proibida, para mostrar o executor recusando. */
function adversario(ferramenta: string, args: Record<string, unknown>): ModeloComFerramentas {
  const roteiro = [
    new AIMessage({ content: "", tool_calls: [{ id: "adv_1", name: ferramenta, args, type: "tool_call" }] }),
    new AIMessage(`(dublê) O backend recusou ${ferramenta}.`),
  ];
  return { invoke: async () => roteiro.shift() ?? new AIMessage("") };
}

await cenario("7. Viagens: recuperação com fonte (França)", async (s) =>
  ultimaResposta(await servico.enviarMensagem(s, "Qual documentação preciso para viajar para a França?", "viagens")),
);

await cenario("8. Viagens: pergunta sem evidência na base (Itália)", async (s) =>
  ultimaResposta(await servico.enviarMensagem(s, "Preciso de visto para ir à Itália a turismo?", "viagens")),
);

await cenario("9. Viagens pedindo chamados: modelo real (não recebe a ferramenta)", async (s) =>
  ultimaResposta(await servico.enviarMensagem(s, "Consulte o chamado CH-101.", "viagens")),
);

await cenario("10. Viagens pedindo chamados: dublê adversário (executor recusa)", async (s) => {
  const grafo = criarGrafo({ modelo: adversario("consultar_chamado", { id: "CH-101" }) });
  const v = await criarServico(grafo).enviarMensagem(s, "Consulte o chamado CH-101.", "viagens");
  return v.itens.filter((i) => i.tipo === "resultado").map((i) => JSON.stringify(i)).join(" ");
});

await cenario("11. Suporte pedindo o RAG: modelo real (não recebe a ferramenta)", async (s) =>
  ultimaResposta(await servico.enviarMensagem(s, "Quais documentos preciso para viajar para a França?", "suporte")),
);

await cenario("12. Suporte pedindo o RAG: dublê adversário (executor recusa)", async (s) => {
  const grafo = criarGrafo({ modelo: adversario("call_rag", { pergunta: "Documentos para a França", pais: "França" }) });
  const v = await criarServico(grafo).enviarMensagem(s, "Documentos para a França?", "suporte");
  return v.itens.filter((i) => i.tipo === "resultado").map((i) => JSON.stringify(i)).join(" ");
});

await awaitAllCallbacks(); // garante que os rastros foram enviados antes de sair

console.log(`\nProjeto LangSmith: ${process.env.LANGSMITH_PROJECT} (filtre por metadata thread_id = sessão)\n`);
for (const r of resumo) console.log(`${r.cenario}\n  sessão: ${r.sessao}\n  → ${r.resultado}\n`);
