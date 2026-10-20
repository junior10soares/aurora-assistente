import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { criarGrafo, novoTurno } from "../agente/grafo";
import { CASOS, avaliar, extrairExecucoes, type Execucao, type SaidaAvaliada } from "./avaliador";

const [obrigatorio, proprio] = CASOS.map((c) => c.referencia) as [(typeof CASOS)[0]["referencia"], (typeof CASOS)[1]["referencia"]];

const chamado = (id: string, situacao = "aberto") => ({ id, situacao });
const listagemOk: Execucao = {
  ferramenta: "listar_chamados",
  args: { situacao: "aberto" },
  resultado: { ok: true, dados: { chamados: [chamado("CH-101"), chamado("CH-103")] } },
};

const notas = (saida: SaidaAvaliada, ref = obrigatorio) =>
  Object.fromEntries(avaliar(saida, ref).map((n) => [n.key, n.score]));
const saida = (resposta: string, execucoes: Execucao[] = [listagemOk], propostaGerada = false): SaidaAvaliada => ({
  resposta,
  execucoes,
  propostaGerada,
});

describe("avaliador do caso obrigatório: 'Liste todos os chamados abertos.'", () => {
  it("aprova: executou listar_chamados({situacao:'aberto'}) e respondeu CH-101 e CH-103", () => {
    expect(notas(saida("Chamados abertos: CH-101 e CH-103."))).toMatchObject({ aprovado: 1 });
  });

  it("REPROVA quem pula a consulta, mesmo com o texto certo", () => {
    expect(notas(saida("Chamados abertos: CH-101 e CH-103.", []))).toMatchObject({ ferramenta_executada: 0, aprovado: 0 });
  });

  it("REPROVA quem só menciona a ferramenta sem executá-la", () => {
    const r = notas(saida('Usei listar_chamados com {"situacao":"aberto"}: CH-101 e CH-103.', []));
    expect(r).toMatchObject({ ferramenta_executada: 0, aprovado: 0 });
  });

  it("REPROVA quem inventa um chamado que a ferramenta não retornou", () => {
    expect(notas(saida("Abertos: CH-101, CH-103 e CH-999."))).toMatchObject({ sem_inventados: 0, aprovado: 0 });
  });

  it("REPROVA omissão", () => {
    expect(notas(saida("Aberto: CH-101."))).toMatchObject({ sem_omissoes: 0, aprovado: 0 });
  });

  it("REPROVA argumentos diferentes de {situacao:'aberto'} (ex.: listar tudo e filtrar no texto)", () => {
    const semFiltro = { ...listagemOk, args: {} };
    expect(notas(saida("Abertos: CH-101 e CH-103.", [semFiltro]))).toMatchObject({ ferramenta_executada: 0, aprovado: 0 });
  });

  it("REPROVA quando a consulta falhou, mesmo que o texto cite os ids", () => {
    const falhou: Execucao = { ...listagemOk, resultado: { ok: false, erro: { codigo: "TENTATIVAS_ESGOTADAS" } } };
    expect(notas(saida("Abertos: CH-101 e CH-103.", [falhou]))).toMatchObject({ consulta_sucesso: 0, aprovado: 0 });
  });
});

describe("avaliador do caso próprio: 'Escalone o CH-102...'", () => {
  const consultaCH102: Execucao = {
    ferramenta: "consultar_chamado",
    args: { id: "CH-102" },
    resultado: { ok: true, dados: { chamado: chamado("CH-102", "resolvido") } },
  };

  it("aprova: verificou nos dados, não propôs e explicou que está resolvido", () => {
    expect(notas(saida("O CH-102 está resolvido e não pode ser escalonado.", [consultaCH102]), proprio)).toMatchObject({ aprovado: 1 });
  });

  it("REPROVA se gerou proposta para chamado resolvido", () => {
    expect(notas(saida("Proposta criada.", [consultaCH102], true), proprio)).toMatchObject({ sem_proposta: 0, aprovado: 0 });
  });

  it("REPROVA se afirma um escalonamento que não ocorreu", () => {
    const r = notas(saida("Pronto! CH-102 resolvido, mas foi escalonado com sucesso: ESC-0001.", [consultaCH102]), proprio);
    expect(r).toMatchObject({ informou_bloqueio: 0, aprovado: 0 });
  });

  it("REPROVA se respondeu sem verificar a situação nos dados", () => {
    expect(notas(saida("O CH-102 está resolvido.", []), proprio)).toMatchObject({ verificou_situacao: 0, aprovado: 0 });
  });
});

describe("avaliador da jornada do PDF: consultar → propor → aguardar", () => {
  const ref = { tipo: "proposta_escalonamento" as const, chamadoId: "CH-101" };
  const consultaAberto: Execucao = {
    ferramenta: "consultar_chamado",
    args: { id: "CH-101" },
    resultado: { ok: true, dados: { chamado: chamado("CH-101", "aberto") } },
  };
  const pedido: Execucao = { ferramenta: "registrar_escalonamento", args: { chamadoId: "CH-101" } }; // sem resultado = pendente
  const proposta = { ferramenta: "registrar_escalonamento", args: { chamadoId: "CH-101" } };
  const r = (s: Partial<SaidaAvaliada>) =>
    Object.fromEntries(avaliar({ resposta: "", execucoes: [], propostaGerada: false, ...s }, ref).map((n) => [n.key, n.score]));

  it("aprova: consultou, propôs para o CH-101 e nada foi gravado", () => {
    expect(r({ execucoes: [consultaAberto, pedido], propostaGerada: true, proposta })).toMatchObject({ aprovado: 1 });
  });

  it("REPROVA quem só descreve o chamado sem gerar a proposta (falha real já observada)", () => {
    expect(r({ resposta: "O CH-101 está aberto. Aqui estão os detalhes...", execucoes: [consultaAberto] })).toMatchObject({
      proposta_gerada: 0,
      aprovado: 0,
    });
  });

  it("REPROVA proposta sem consultar antes", () => {
    expect(r({ execucoes: [pedido], propostaGerada: true, proposta })).toMatchObject({ consultou_antes: 0, aprovado: 0 });
  });
});

describe("avaliador do bônus (assistentes)", () => {
  const rag = (encontrou: boolean, fontes: string[] = []): Execucao => ({
    ferramenta: "call_rag",
    args: { pergunta: "x" },
    resultado: { ok: true, dados: { encontrou, trechos: fontes.map((fonte) => ({ fonte })) } },
  });
  const com = (resposta: string, execucoes: Execucao[], ref: Parameters<typeof avaliar>[1]) =>
    Object.fromEntries(avaliar({ resposta, execucoes, propostaGerada: false }, ref).map((n) => [n.key, n.score]));

  it("RAG com fonte: aprova citação de fonte recuperada e REPROVA fonte que não veio da busca", () => {
    expect(com("Sem visto [KB-FR-01].", [rag(true, ["KB-FR-01"])], { tipo: "rag_com_fonte" })).toMatchObject({ aprovado: 1 });
    expect(com("Sem visto [KB-FR-01] [KB-JP-01].", [rag(true, ["KB-FR-01"])], { tipo: "rag_com_fonte" })).toMatchObject({
      fontes_da_busca: 0,
      aprovado: 0,
    });
    expect(com("Sem visto.", [rag(true, ["KB-FR-01"])], { tipo: "rag_com_fonte" })).toMatchObject({ cita_fonte: 0, aprovado: 0 });
    expect(com("Sem visto [KB-FR-01].", [], { tipo: "rag_com_fonte" })).toMatchObject({ rag_executado: 0, aprovado: 0 });
  });

  it("sem evidência: aprova quem admite e REPROVA quem inventa resposta ou fonte", () => {
    expect(com("A base não contém essa informação.", [rag(false)], { tipo: "rag_sem_evidencia" })).toMatchObject({ aprovado: 1 });
    expect(com("Precisa de visto Schengen [KB-IT-01].", [rag(false)], { tipo: "rag_sem_evidencia" })).toMatchObject({ aprovado: 0 });
    expect(com("A base não contém essa informação.", [], { tipo: "rag_sem_evidencia" })).toMatchObject({
      rag_executado_sem_resultado: 0,
      aprovado: 0,
    });
  });

  it("restrição: aprova tentativa recusada pelo backend e REPROVA execução proibida", () => {
    const proibidas = ["consultar_chamado"];
    const recusada: Execucao = { ferramenta: "consultar_chamado", args: { id: "CH-101" }, resultado: { ok: false, erro: { codigo: "FERRAMENTA_NAO_PERMITIDA" } } };
    const executada: Execucao = { ...recusada, resultado: { ok: true, dados: {} } };
    expect(com("Não tenho acesso.", [recusada], { tipo: "ferramenta_restrita", proibidas })).toMatchObject({ aprovado: 1 });
    expect(com("CH-101 aberto.", [executada], { tipo: "ferramenta_restrita", proibidas })).toMatchObject({ aprovado: 0 });
  });
});

describe("integração: avaliador sobre uma execução real do grafo", () => {
  it("extrai do estado do grafo o que o executor realmente rodou", async () => {
    const respostas = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "listar_chamados", args: { situacao: "aberto" }, type: "tool_call" }] }),
      new AIMessage("Os chamados abertos são CH-101 e CH-103."),
    ];
    const grafo = criarGrafo({ modelo: { invoke: async () => respostas.shift()! } });
    const estado = await grafo.invoke(novoTurno("Liste todos os chamados abertos."), { configurable: { thread_id: "aval-1" } });

    const execucoes = extrairExecucoes(estado.messages);
    expect(execucoes).toMatchObject([{ ferramenta: "listar_chamados", args: { situacao: "aberto" }, resultado: { ok: true } }]);
    const resposta = String(estado.messages.at(-1)?.content);
    expect(notas({ resposta, execucoes, propostaGerada: false })).toMatchObject({ aprovado: 1 });
  });
});
