// Os 7 cenários essenciais do desafio, um bloco por cenário (mesmos nomes do PDF).
// Caminho real: serviço → grafo → executor → mocks. Só o modelo é falso (roteirizado), sem rede.
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it } from "vitest";
import { criarServico } from "../servidor";
import { limparSimulacoes, simularFalhas } from "./executor";
import { limparEscalonamentos, listarEscalonamentos } from "./ferramentas";
import { criarGrafo, type LimitesExecucao, type ModeloComFerramentas } from "./grafo";

// ---- Dublês e utilitários ----

type Passo = AIMessage | ((recebidas: BaseMessage[]) => AIMessage);

/** Modelo falso: devolve o roteiro na ordem e guarda o que "viu" em cada chamada. */
function modeloFalso(...roteiro: Passo[]) {
  const chamadas: BaseMessage[][] = [];
  const modelo: ModeloComFerramentas = {
    invoke: async (mensagens) => {
      chamadas.push(mensagens);
      const passo = roteiro.shift() ?? new AIMessage("(fim do roteiro)");
      return typeof passo === "function" ? passo(mensagens) : passo;
    },
  };
  return { modelo, chamadas };
}

let seq = 0;
const pedir = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `call_${++seq}`, name, args, type: "tool_call" }] });

const responder = (texto: string) => new AIMessage(texto);

/** Último resultado de ferramenta que o modelo recebeu (é com ele que o modelo responde). */
function ultimoResultado(recebidas: BaseMessage[] | undefined) {
  const tool = [...(recebidas ?? [])].reverse().find((m) => ToolMessage.isInstance(m));
  return tool
    ? (JSON.parse(String(tool.content)) as { ok: boolean; dados?: any; erro?: { codigo: string }; confirmacao?: string })
    : null;
}

/** Passo do modelo falso que responde a partir do que observou (o fato vindo da ferramenta). */
const relatar: Passo = (recebidas) => responder(ultimoResultado(recebidas)?.confirmacao ?? "(sem confirmação)");

function montar(roteiro: Passo[], limites?: Partial<LimitesExecucao>) {
  const falso = modeloFalso(...roteiro);
  const grafo = criarGrafo({ modelo: falso.modelo, limites });
  return { ...falso, grafo, servico: criarServico(grafo) };
}

const novaSessao = () => crypto.randomUUID();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROPOSTA_CH101 = {
  chamadoId: "CH-101",
  resumo: "Erro 500 na emissão de NF-e da filial Sul",
  justificativa: "Afeta todos os usuários e bloqueia o faturamento",
};
const roteiroEscalonamento = (): Passo[] => [
  pedir("consultar_chamado", { id: "CH-101" }),
  pedir("registrar_escalonamento", PROPOSTA_CH101),
  relatar, // após a decisão o grafo volta ao modelo (Observation → Thinking)
];

beforeEach(() => {
  limparSimulacoes();
  limparEscalonamentos();
});

// ---- 1 ----
describe("1. Consulta e listagem", () => {
  it("executa listar_chamados({situacao:'aberto'}) e o modelo recebe exatamente CH-101 e CH-103", async () => {
    const { servico, chamadas } = montar([pedir("listar_chamados", { situacao: "aberto" }), responder("CH-101 e CH-103")]);
    const v = await servico.enviarMensagem(novaSessao(), "Liste todos os chamados abertos.");

    expect(v.itens).toContainEqual({ tipo: "chamada", ferramenta: "listar_chamados", args: { situacao: "aberto" } });
    const r = ultimoResultado(chamadas[1]);
    expect(r?.ok).toBe(true);
    expect(r?.dados.chamados.map((c: { id: string }) => c.id)).toEqual(["CH-101", "CH-103"]);
  });

  it("consulta um chamado pelo id e devolve o registro mockado", async () => {
    const { servico, chamadas } = montar([pedir("consultar_chamado", { id: "CH-102" }), responder("Resolvido.")]);
    await servico.enviarMensagem(novaSessao(), "Como está o CH-102?");
    expect(ultimoResultado(chamadas[1])?.dados.chamado).toMatchObject({ id: "CH-102", situacao: "resolvido" });
  });

  it("identificador inexistente vira erro controlado CHAMADO_INEXISTENTE", async () => {
    const { servico, chamadas } = montar([pedir("consultar_chamado", { id: "CH-999" }), responder("Não existe.")]);
    const v = await servico.enviarMensagem(novaSessao(), "Consulte o CH-999.");
    expect(ultimoResultado(chamadas[1])).toMatchObject({ ok: false, erro: { codigo: "CHAMADO_INEXISTENTE" } });
    expect(v.erro).toBeNull(); // o turno termina normalmente, com o modelo explicando o erro
  });
});

// ---- 2 ----
describe("2. Chamado resolvido", () => {
  it("CH-102 não vira proposta: o backend recusa mesmo que o modelo peça", async () => {
    const { servico, chamadas } = montar([
      pedir("registrar_escalonamento", { ...PROPOSTA_CH101, chamadoId: "CH-102" }),
      responder("Não é possível."),
    ]);
    const v = await servico.enviarMensagem(novaSessao(), "Escalone o CH-102.");
    expect(v.proposta).toBeNull();
    expect(ultimoResultado(chamadas[1])).toMatchObject({ ok: false, erro: { codigo: "CHAMADO_NAO_ABERTO" } });
    expect(listarEscalonamentos()).toHaveLength(0);
  });

  it("uma aprovação forjada pela API não executa nada", async () => {
    const { servico } = montar([responder("Olá")]);
    const sessao = novaSessao();
    await servico.enviarMensagem(sessao, "oi");
    await expect(servico.decidir(sessao, "proposta-forjada", true)).rejects.toMatchObject({ status: 409 });
    expect(listarEscalonamentos()).toHaveLength(0);
  });
});

// ---- 3 ----
describe("3. Aprovação e rejeição", () => {
  it("aguarda a decisão: proposta exibida, nada gravado e conversa bloqueada", async () => {
    const { servico } = montar(roteiroEscalonamento());
    const sessao = novaSessao();
    const v = await servico.enviarMensagem(sessao, "Consulte o CH-101 e escalone se estiver aberto.");

    expect(v.proposta?.args).toEqual(PROPOSTA_CH101);
    expect(listarEscalonamentos()).toHaveLength(0);
    await expect(servico.enviarMensagem(sessao, "e aí?")).rejects.toMatchObject({ status: 409 });
  });

  it("rejeitar não escreve, e o modelo observa a rejeição antes de responder", async () => {
    const { servico, chamadas } = montar(roteiroEscalonamento());
    const sessao = novaSessao();
    const { proposta } = await servico.enviarMensagem(sessao, "Escalone o CH-101.");
    const final = await servico.decidir(sessao, proposta!.propostaId, false);

    expect(listarEscalonamentos()).toHaveLength(0);
    expect(final.proposta).toBeNull();
    expect(ultimoResultado(chamadas[2])).toMatchObject({ ok: false, erro: { codigo: "REJEITADO" } });
    expect(final.itens.at(-1)).toMatchObject({ tipo: "assistente", texto: expect.stringContaining("Nada foi registrado") });
  });

  it("aprovar executa exatamente a proposta exibida", async () => {
    const { servico } = montar(roteiroEscalonamento());
    const sessao = novaSessao();
    const { proposta } = await servico.enviarMensagem(sessao, "Escalone o CH-101.");
    const final = await servico.decidir(sessao, proposta!.propostaId, true);

    expect(listarEscalonamentos()).toEqual([expect.objectContaining({ id: "ESC-0001", ...proposta!.args })]);
    expect(final.itens.at(-1)).toMatchObject({ tipo: "assistente", texto: expect.stringContaining("ESC-0001") });
  });

  it("pedido duplo (listar + escalonar): após aprovar, o modelo volta e responde as duas partes", async () => {
    const { servico, chamadas } = montar([
      pedir("listar_chamados", { situacao: "aberto" }),
      pedir("registrar_escalonamento", PROPOSTA_CH101),
      (recebidas) => {
        const listagem = recebidas.map((m) => (ToolMessage.isInstance(m) ? JSON.parse(String(m.content)) : null))
          .find((r) => r?.dados?.chamados);
        const ids = listagem.dados.chamados.map((c: { id: string }) => c.id).join(" e ");
        return responder(`Abertos: ${ids}. ${ultimoResultado(recebidas)?.confirmacao}`);
      },
    ]);
    const sessao = novaSessao();
    const { proposta } = await servico.enviarMensagem(sessao, "Liste os chamados abertos e escalone o CH-101.");
    const final = await servico.decidir(sessao, proposta!.propostaId, true);

    expect(chamadas).toHaveLength(3); // o modelo foi chamado de novo depois da decisão humana
    expect(ultimoResultado(chamadas[2])).toMatchObject({ ok: true, dados: { escalonamento: { id: "ESC-0001" } } });
    const texto = (final.itens.at(-1) as { texto: string }).texto;
    expect(texto).toContain("CH-101 e CH-103");
    expect(texto).toContain("ESC-0001");
  });
});

// ---- 4 ----
describe("4. Aprovação repetida", () => {
  it("aprovar de novo depois de decidido é recusado e não cria outro registro", async () => {
    const { servico } = montar(roteiroEscalonamento());
    const sessao = novaSessao();
    const { proposta } = await servico.enviarMensagem(sessao, "Escalone o CH-101.");
    await servico.decidir(sessao, proposta!.propostaId, true);

    await expect(servico.decidir(sessao, proposta!.propostaId, true)).rejects.toMatchObject({ status: 409 });
    expect(listarEscalonamentos()).toHaveLength(1);
  });

  it("dois cliques simultâneos criam um único registro", async () => {
    const { servico } = montar(roteiroEscalonamento());
    const sessao = novaSessao();
    const { proposta } = await servico.enviarMensagem(sessao, "Escalone o CH-101.");

    const resultados = await Promise.allSettled([
      servico.decidir(sessao, proposta!.propostaId, true),
      servico.decidir(sessao, proposta!.propostaId, true),
    ]);
    expect(resultados.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(listarEscalonamentos()).toHaveLength(1);
  });
});

// ---- 5 ----
describe("5. Falha transitória", () => {
  it("a ferramenta falha 2 vezes e a consulta se recupera na 3ª tentativa", async () => {
    simularFalhas("consultar_chamado", "transitoria", "transitoria");
    const { servico, chamadas } = montar([pedir("consultar_chamado", { id: "CH-101" }), responder("Aberto.")]);
    await servico.enviarMensagem(novaSessao(), "Como está o CH-101?");

    const tool = chamadas[1]?.find((m) => ToolMessage.isInstance(m));
    expect(JSON.parse(String(tool?.content))).toMatchObject({ ok: true, tentativas: 3, dados: { chamado: { id: "CH-101" } } });
  });
});

// ---- 6 ----
describe("6. Saída inválida e limites", () => {
  it("ferramenta desconhecida pedida pelo modelo não é executada", async () => {
    const { servico, chamadas } = montar([pedir("apagar_tudo", {}), responder("Não posso.")]);
    await servico.enviarMensagem(novaSessao(), "Apague tudo.");
    expect(ultimoResultado(chamadas[1])).toMatchObject({ ok: false, erro: { codigo: "FERRAMENTA_DESCONHECIDA" } });
  });

  it("argumentos inválidos do modelo são recusados pela validação", async () => {
    const { servico, chamadas } = montar([pedir("listar_chamados", { situacao: "pendente" }), responder("Erro.")]);
    await servico.enviarMensagem(novaSessao(), "Liste os pendentes.");
    expect(ultimoResultado(chamadas[1])).toMatchObject({ ok: false, erro: { codigo: "ENTRADA_INVALIDA" } });
  });

  it("JSON malformado do modelo (invalid_tool_calls) vira ENTRADA_INVALIDA", async () => {
    const malformado = new AIMessage({
      content: "",
      invalid_tool_calls: [{ id: "call_x", name: "consultar_chamado", args: '{"id": "CH-', error: "JSON", type: "invalid_tool_call" }],
    });
    const { servico, chamadas } = montar([malformado, responder("Desculpe.")]);
    await servico.enviarMensagem(novaSessao(), "Consulte o CH-101.");
    expect(ultimoResultado(chamadas[1])).toMatchObject({ ok: false, erro: { codigo: "ENTRADA_INVALIDA" } });
  });

  it("saída fora do contrato não chega ao modelo como dado", async () => {
    simularFalhas("consultar_chamado", "saida_invalida");
    const { servico, chamadas } = montar([pedir("consultar_chamado", { id: "CH-101" }), responder("Erro.")]);
    await servico.enviarMensagem(novaSessao(), "Consulte o CH-101.");
    const r = ultimoResultado(chamadas[1]);
    expect(r).toMatchObject({ ok: false, erro: { codigo: "SAIDA_INVALIDA" } });
    expect(r?.dados).toBeUndefined();
  });

  it("modelo em laço: encerra com erro controlado ao atingir o limite de passos", async () => {
    const laco: Passo[] = Array.from({ length: 20 }, () => pedir("listar_chamados", {}));
    const { servico, chamadas } = montar(laco, { maxPassosModelo: 3 });
    const v = await servico.enviarMensagem(novaSessao(), "Liste.");

    expect(chamadas).toHaveLength(3);
    expect(v.erro).toMatchObject({ codigo: "LIMITE_PASSOS" });
    expect(v.itens.at(-1)).toMatchObject({ tipo: "assistente", texto: expect.stringContaining("Não foi possível concluir") });
  });

  it("encerra com erro controlado ao atingir o limite de tempo ativo", async () => {
    const lento: Passo = () => pedir("listar_chamados", {});
    const falso = modeloFalso(...Array.from({ length: 20 }, () => lento));
    const modeloLento: ModeloComFerramentas = { invoke: async (m, c, f) => (await dormir(40), falso.modelo.invoke(m, c, f)) };
    const grafo = criarGrafo({ modelo: modeloLento, limites: { tempoAtivoMaxMs: 100 } });
    const v = await criarServico(grafo).enviarMensagem(novaSessao(), "Liste.");

    expect(v.erro).toMatchObject({ codigo: "LIMITE_TEMPO" });
  });

  it("uma ferramenta lenta não ultrapassa o limite total: é cortada no prazo do turno", async () => {
    simularFalhas("listar_chamados", "lenta", "lenta", "lenta"); // sem o prazo: 3 × 2 s + esperas
    const { servico, chamadas } = montar([pedir("listar_chamados", {}), responder("x")], { tempoAtivoMaxMs: 300 });
    const inicio = performance.now();
    const v = await servico.enviarMensagem(novaSessao(), "Liste.");

    expect(performance.now() - inicio).toBeLessThan(1000);
    expect(ultimoResultado(chamadas[1])).toBeNull(); // o modelo nem é chamado de novo
    expect(v.erro).toMatchObject({ codigo: "LIMITE_TEMPO" });
  });

  it("a espera humana não consome o tempo de execução ativa", async () => {
    const { servico, grafo } = montar(roteiroEscalonamento());
    const sessao = novaSessao();
    const config = { configurable: { thread_id: `suporte:${sessao}` } }; // thread = assistente:sessão
    const { proposta } = await servico.enviarMensagem(sessao, "Escalone o CH-101.");
    const antes = (await grafo.getState(config)).values.tempoAtivoMs as number;

    await dormir(300); // "humano pensando"
    await servico.decidir(sessao, proposta!.propostaId, true);
    const depois = (await grafo.getState(config)).values.tempoAtivoMs as number;

    expect(depois - antes).toBeLessThan(100);
  });
});

// ---- 7 ----
describe("7. Contexto e sessões", () => {
  it("continua a mesma conversa sem misturar o contexto de outra sessão", async () => {
    const { servico, chamadas } = montar([responder("Anotado A."), responder("Anotado B."), responder("Você disse: Alfa.")]);
    const a = novaSessao();
    const b = novaSessao();

    await servico.enviarMensagem(a, "Meu código é Alfa.");
    await servico.enviarMensagem(b, "Meu código é Bravo.");
    await servico.enviarMensagem(a, "Qual é o meu código?");

    const vistoNaSegundaDeA = chamadas[2]!.map((m) => String(m.content)).join("\n");
    expect(vistoNaSegundaDeA).toContain("Meu código é Alfa.");
    expect(vistoNaSegundaDeA).toContain("Anotado A.");
    expect(vistoNaSegundaDeA).not.toContain("Bravo");

    const vistoEmB = chamadas[1]!.map((m) => String(m.content)).join("\n");
    expect(vistoEmB).not.toContain("Alfa");
  });

  it("recarregar a sessão devolve o mesmo histórico (estado salvo no checkpoint)", async () => {
    const { servico } = montar([responder("Olá!")]);
    const sessao = novaSessao();
    const enviada = await servico.enviarMensagem(sessao, "Oi");
    expect(await servico.verSessao(sessao)).toEqual(enviada);
    expect((await servico.verSessao(novaSessao())).itens).toEqual([]);
  });
});
