// Bônus (B3/B4): um único grafo com dois assistentes configurados em execução.
// Mesmo caminho real (serviço → grafo → executor); só o modelo é dublê.
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it } from "vitest";
import { buscar } from "../viagens/base";
import { criarServico } from "../servidor";
import { limparEscalonamentos, listarEscalonamentos } from "./ferramentas";
import { criarGrafo, type ModeloComFerramentas } from "./grafo";

let seq = 0;
const pedir = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `call_${++seq}`, name, args, type: "tool_call" }] });

/** Dublê que segue o roteiro e registra as mensagens e as FERRAMENTAS que recebeu em cada chamada. */
function montar(...roteiro: AIMessage[]) {
  const recebidas: BaseMessage[][] = [];
  const ferramentasVistas: string[][] = [];
  const modelo: ModeloComFerramentas = {
    invoke: async (mensagens, _config, ferramentas) => {
      recebidas.push(mensagens);
      ferramentasVistas.push(ferramentas.map((f) => f.name));
      return roteiro.shift() ?? new AIMessage("(fim)");
    },
  };
  const grafo = criarGrafo({ modelo });
  return { servico: criarServico(grafo), recebidas, ferramentasVistas };
}

function resultado(recebidas: BaseMessage[] | undefined) {
  const tool = [...(recebidas ?? [])].reverse().find((m) => ToolMessage.isInstance(m));
  return JSON.parse(String(tool?.content ?? "null"));
}

const sessao = () => crypto.randomUUID();

beforeEach(() => limparEscalonamentos());

describe("B3. Um grafo, configurações de assistentes", () => {
  it("o mesmo grafo usa prompt e ferramentas diferentes conforme o assistente da execução", async () => {
    const { servico, recebidas, ferramentasVistas } = montar(new AIMessage("Oi do suporte."), new AIMessage("Oi de viagens."));
    const s = sessao();
    await servico.enviarMensagem(s, "Olá", "suporte");
    await servico.enviarMensagem(s, "Olá", "viagens");

    expect(ferramentasVistas[0]).toEqual(["listar_chamados", "consultar_chamado", "registrar_escalonamento"]);
    expect(ferramentasVistas[1]).toEqual(["call_rag"]);
    expect(String(recebidas[0]![0]!.content)).toContain("assistente de suporte");
    expect(String(recebidas[1]![0]!.content)).toContain("documentação de viagens");
  });

  it("histórico separado por assistente na mesma sessão", async () => {
    const { servico, recebidas } = montar(new AIMessage("ok"), new AIMessage("ok"), new AIMessage("ok"));
    const s = sessao();
    await servico.enviarMensagem(s, "Mensagem para o SUPORTE", "suporte");
    await servico.enviarMensagem(s, "Mensagem para VIAGENS", "viagens");
    await servico.enviarMensagem(s, "De novo no suporte", "suporte");

    const vistoPeloSuporte = recebidas[2]!.map((m) => String(m.content)).join("\n");
    expect(vistoPeloSuporte).toContain("Mensagem para o SUPORTE");
    expect(vistoPeloSuporte).not.toContain("VIAGENS");
    expect((await servico.verSessao(s, "viagens")).itens.filter((i) => i.tipo === "usuario")).toHaveLength(1);
  });
});

describe("B4. A separação funciona", () => {
  it("recuperação com fonte: França devolve trechos identificados (KB-FR-*)", async () => {
    const { servico, recebidas } = montar(
      pedir("call_rag", { pergunta: "Qual documentação preciso para viajar para a França?", pais: "França" }),
      new AIMessage("Para turismo até 90 dias com passaporte brasileiro... [KB-FR-01]"),
    );
    await servico.enviarMensagem(sessao(), "Qual documentação preciso para viajar para a França?", "viagens");

    const r = resultado(recebidas[1]);
    expect(r).toMatchObject({ ok: true, dados: { encontrou: true } });
    const fontes = r.dados.trechos.map((t: { fonte: string }) => t.fonte);
    expect(fontes).toContain("KB-FR-01");
    expect(fontes.every((f: string) => f.startsWith("KB-FR-"))).toBe(true);
    expect(r.dados.trechos[0].aplicaA).toMatchObject({ pais: "França" }); // nacionalidade/finalidade/duração explícitas
  });

  it("pergunta sem evidência: país fora da base devolve encontrou=false (sem chutar)", async () => {
    const { servico, recebidas } = montar(
      pedir("call_rag", { pergunta: "Preciso de visto para a Itália?", pais: "Itália" }),
      new AIMessage("A base não contém informações sobre a Itália."),
    );
    await servico.enviarMensagem(sessao(), "Preciso de visto para a Itália?", "viagens");
    expect(resultado(recebidas[1])).toMatchObject({ ok: true, dados: { encontrou: false, trechos: [] } });
  });

  it("Viagens tentando usar ferramentas de chamados: o executor recusa", async () => {
    const { servico, recebidas } = montar(
      pedir("consultar_chamado", { id: "CH-101" }),
      pedir("registrar_escalonamento", {
        chamadoId: "CH-101",
        resumo: "Tentativa indevida pelo assistente de viagens",
        justificativa: "Não deveria ser possível executar isto",
      }),
      new AIMessage("Não tenho acesso a chamados."),
    );
    const v = await servico.enviarMensagem(sessao(), "Consulte o CH-101 e escalone.", "viagens");

    expect(resultado(recebidas[1])).toMatchObject({ ok: false, erro: { codigo: "FERRAMENTA_NAO_PERMITIDA" } });
    expect(resultado(recebidas[2])).toMatchObject({ ok: false, erro: { codigo: "FERRAMENTA_NAO_PERMITIDA" } });
    expect(v.proposta).toBeNull();
    expect(listarEscalonamentos()).toHaveLength(0);
  });

  it("Suporte tentando consultar o RAG: o executor recusa", async () => {
    const { servico, recebidas } = montar(
      pedir("call_rag", { pergunta: "Documentos para a França", pais: "França" }),
      new AIMessage("Não tenho acesso à base de viagens."),
    );
    await servico.enviarMensagem(sessao(), "Quais documentos para a França?", "suporte");
    expect(resultado(recebidas[1])).toMatchObject({ ok: false, erro: { codigo: "FERRAMENTA_NAO_PERMITIDA" } });
  });
});

describe("recuperação (busca na base local)", () => {
  it("filtros de finalidade e nacionalidade restringem os trechos", () => {
    expect(buscar("estudar na França", { pais: "França", finalidade: "estudo" }).map((d) => d.fonte)).toEqual(["KB-FR-02"]);
    expect(buscar("turismo", { pais: "França", nacionalidade: "União Europeia" }).map((d) => d.fonte)).toEqual(["KB-FR-03"]);
  });

  it("sem filtro de país, só devolve com evidência suficiente na pergunta", () => {
    expect(buscar("Qual documentação preciso para viajar para a Itália?")).toEqual([]);
    expect(buscar("visto eletrônico para turismo no Japão").map((d) => d.fonte)[0]).toBe("KB-JP-01");
  });
});
