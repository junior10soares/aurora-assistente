import { beforeEach, describe, expect, it } from "vitest";
import { executarFerramenta, limparSimulacoes, prepararProposta, simularFalhas } from "./executor";
import { limparEscalonamentos, listarEscalonamentos } from "./ferramentas";

// Limites curtos para os testes não demorarem.
const limites = { timeoutMs: 50, esperaEntreTentativasMs: 1 };

const escalonamentoCH101 = {
  chamadoId: "CH-101",
  resumo: "Erro 500 na emissão de NF-e da filial Sul",
  justificativa: "Afeta todos os usuários da filial e bloqueia o faturamento",
};

beforeEach(() => {
  limparSimulacoes();
  limparEscalonamentos();
});

describe("consulta e listagem", () => {
  it("listar_chamados filtra pela situação", async () => {
    const r = await executarFerramenta("listar_chamados", { situacao: "aberto" });
    expect(r.ok && (r.dados as { chamados: { id: string }[] }).chamados.map((c) => c.id)).toEqual(["CH-101", "CH-103"]);
  });

  it("listar_chamados sem filtro devolve todos", async () => {
    const r = await executarFerramenta("listar_chamados", {});
    expect(r.ok && (r.dados as { chamados: unknown[] }).chamados).toHaveLength(4);
  });

  it("consultar_chamado normaliza o identificador", async () => {
    const r = await executarFerramenta("consultar_chamado", { id: " ch-102 " });
    expect(r).toMatchObject({ ok: true, dados: { chamado: { id: "CH-102", situacao: "resolvido" } } });
  });

  it("chamado inexistente é erro definitivo (sem novas tentativas)", async () => {
    const r = await executarFerramenta("consultar_chamado", { id: "CH-999" });
    expect(r).toMatchObject({ ok: false, erro: { codigo: "CHAMADO_INEXISTENTE" }, tentativas: 1 });
  });
});

describe("entrada inválida e ferramenta desconhecida", () => {
  it.each([
    ["listar_chamados", { situacao: "fechado" }],
    ["consultar_chamado", { id: 101 }],
    ["consultar_chamado", {}],
  ])("%s com %j → ENTRADA_INVALIDA", async (nome, args) => {
    const r = await executarFerramenta(nome, args);
    expect(r).toMatchObject({ ok: false, erro: { codigo: "ENTRADA_INVALIDA" } });
  });

  it.each(["apagar_tudo", "__proto__", "constructor"])("%s → FERRAMENTA_DESCONHECIDA", async (nome) => {
    const r = await executarFerramenta(nome, {});
    expect(r).toMatchObject({ ok: false, erro: { codigo: "FERRAMENTA_DESCONHECIDA" } });
  });
});

describe("escalonamento: regra de negócio, aprovação e idempotência", () => {
  it("não registra sem aprovação, mesmo com argumentos válidos", async () => {
    const r = await executarFerramenta("registrar_escalonamento", escalonamentoCH101);
    expect(r).toMatchObject({ ok: false, erro: { codigo: "APROVACAO_NECESSARIA" } });
    expect(listarEscalonamentos()).toHaveLength(0);
  });

  it("CH-102 (resolvido) não gera proposta", async () => {
    const r = await prepararProposta("registrar_escalonamento", { ...escalonamentoCH101, chamadoId: "CH-102" });
    expect(r).toMatchObject({ ok: false, erro: { codigo: "CHAMADO_NAO_ABERTO" } });
  });

  it("CH-102 é bloqueado no registro mesmo com uma aprovação forjada", async () => {
    const r = await executarFerramenta(
      "registrar_escalonamento",
      { ...escalonamentoCH101, chamadoId: "CH-102" },
      { aprovacao: { propostaId: "forjada" } },
    );
    expect(r).toMatchObject({ ok: false, erro: { codigo: "CHAMADO_NAO_ABERTO" } });
    expect(listarEscalonamentos()).toHaveLength(0);
  });

  it("aprovação repetida cria apenas um registro", async () => {
    const p = await prepararProposta("registrar_escalonamento", escalonamentoCH101);
    if (!p.ok) throw new Error("proposta deveria ser válida");
    const { propostaId, ferramenta, args } = p.proposta;

    const primeira = await executarFerramenta(ferramenta, args, { aprovacao: { propostaId } });
    const segunda = await executarFerramenta(ferramenta, args, { aprovacao: { propostaId } });

    expect(primeira).toMatchObject({ ok: true, dados: { escalonamento: { id: "ESC-0001" }, jaRegistrado: false } });
    expect(segunda).toMatchObject({ ok: true, dados: { escalonamento: { id: "ESC-0001" }, jaRegistrado: true } });
    expect(listarEscalonamentos()).toHaveLength(1);
  });

  it("a mesma chave com outro conteúdo é recusada", async () => {
    const aprovacao = { propostaId: "p-1" };
    await executarFerramenta("registrar_escalonamento", escalonamentoCH101, { aprovacao });
    const r = await executarFerramenta(
      "registrar_escalonamento",
      { ...escalonamentoCH101, chamadoId: "CH-103" },
      { aprovacao },
    );
    expect(r).toMatchObject({ ok: false, erro: { codigo: "CONFLITO_IDEMPOTENCIA" } });
    expect(listarEscalonamentos()).toHaveLength(1);
  });
});

describe("falhas simuladas, timeout e tentativas", () => {
  it("falha transitória é recuperada dentro do limite", async () => {
    simularFalhas("consultar_chamado", "transitoria", "transitoria");
    const r = await executarFerramenta("consultar_chamado", { id: "CH-101" }, { limites });
    expect(r).toMatchObject({ ok: true, tentativas: 3, dados: { chamado: { id: "CH-101" } } });
  });

  it("encerra com erro controlado ao esgotar as tentativas", async () => {
    simularFalhas("consultar_chamado", "transitoria", "transitoria", "transitoria");
    const r = await executarFerramenta("consultar_chamado", { id: "CH-101" }, { limites });
    expect(r).toMatchObject({ ok: false, tentativas: 3, erro: { codigo: "TENTATIVAS_ESGOTADAS" } });
  });

  it("timeout conta como transitório e é recuperado", async () => {
    simularFalhas("listar_chamados", "lenta");
    const r = await executarFerramenta("listar_chamados", { situacao: "aberto" }, { limites });
    expect(r).toMatchObject({ ok: true, tentativas: 2 });
  });

  it("saída fora do contrato vira SAIDA_INVALIDA e não chega ao modelo", async () => {
    simularFalhas("consultar_chamado", "saida_invalida");
    const r = await executarFerramenta("consultar_chamado", { id: "CH-101" }, { limites });
    expect(r).toMatchObject({ ok: false, tentativas: 1, erro: { codigo: "SAIDA_INVALIDA" } });
  });
});
