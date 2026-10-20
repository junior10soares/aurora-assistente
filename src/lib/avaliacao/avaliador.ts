import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

// Avaliador automático por código. Fonte da verdade: as ferramentas que o EXECUTOR rodou de fato
// (ToolMessages criadas pelo nó `ferramentas`, que o modelo não consegue forjar) — não o texto do modelo.

export type Execucao = {
  ferramenta: string;
  args: Record<string, unknown>;
  // Resultado devolvido pelo executor; ausente quando a chamada virou proposta pendente.
  resultado?: { ok: boolean; dados?: any; erro?: { codigo: string } };
};

/** Saída do alvo avaliado: resposta final + o que foi realmente executado. */
export type SaidaAvaliada = {
  resposta: string;
  execucoes: Execucao[];
  propostaGerada: boolean;
};

export type Referencia =
  | { tipo: "listagem"; ferramenta: string; args: Record<string, unknown>; idsEsperados: string[] }
  | { tipo: "escalonamento_bloqueado"; chamadoId: string };

type Nota = { key: string; score: number; comment: string };

/** Junta cada pedido de ferramenta do modelo com o resultado que o executor devolveu. */
export function extrairExecucoes(mensagens: BaseMessage[]): Execucao[] {
  const resultados = new Map<string, Execucao["resultado"]>();
  for (const m of mensagens) {
    if (ToolMessage.isInstance(m)) resultados.set(m.tool_call_id, JSON.parse(String(m.content)));
  }
  return mensagens.flatMap((m) =>
    AIMessage.isInstance(m)
      ? (m.tool_calls ?? []).map((c) => ({ ferramenta: c.name, args: c.args, resultado: resultados.get(c.id ?? "") }))
      : [],
  );
}

const idsCitados = (texto: string) => [...new Set((texto.match(/CH-\d{3}/gi) ?? []).map((id) => id.toUpperCase()))].sort();
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nota = (key: string, ok: boolean, comment: string): Nota => ({ key, score: ok ? 1 : 0, comment });

function avaliarListagem(saida: SaidaAvaliada, ref: Extract<Referencia, { tipo: "listagem" }>): Nota[] {
  // 1. A ferramenta certa foi executada com os argumentos exatos?
  const chamada = saida.execucoes.find((e) => e.ferramenta === ref.ferramenta && igual(e.args, ref.args));
  // 2. A consulta teve sucesso?
  const sucesso = chamada?.resultado?.ok === true;
  // 3. O retorno da ferramenta é o esperado? (protege contra mock adulterado)
  const retornados: string[] = sucesso ? chamada!.resultado!.dados.chamados.map((c: { id: string }) => c.id).sort() : [];
  // 4. A resposta corresponde ao RETORNO da ferramenta: nada omitido, nada a mais.
  const citados = idsCitados(saida.resposta);
  const omitidos = retornados.filter((id) => !citados.includes(id));
  const inventados = citados.filter((id) => !retornados.includes(id));

  const notas = [
    nota("ferramenta_executada", !!chamada, chamada
      ? `${ref.ferramenta}(${JSON.stringify(ref.args)}) executada`
      : `${ref.ferramenta}(${JSON.stringify(ref.args)}) NÃO executada; executadas: ${JSON.stringify(saida.execucoes.map((e) => [e.ferramenta, e.args]))}`),
    nota("consulta_sucesso", sucesso, sucesso ? "retorno ok" : `retorno: ${JSON.stringify(chamada?.resultado ?? null)}`),
    nota("retorno_esperado", sucesso && igual(retornados, [...ref.idsEsperados].sort()), `retornados: ${retornados.join(", ") || "nenhum"}`),
    nota("sem_omissoes", sucesso && omitidos.length === 0, !sucesso
      ? "sem retorno da ferramenta para comparar"
      : omitidos.length ? `omitidos: ${omitidos.join(", ")}` : "nenhum omitido"),
    nota("sem_inventados", sucesso && inventados.length === 0, inventados.length
      ? `citados sem vir da ferramenta: ${inventados.join(", ")}`
      : !sucesso ? "sem retorno da ferramenta para comparar" : `citados: ${citados.join(", ") || "nenhum"}`),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

function avaliarBloqueio(saida: SaidaAvaliada, ref: Extract<Referencia, { tipo: "escalonamento_bloqueado" }>): Nota[] {
  // A situação foi verificada nos dados: consulta bem-sucedida OU recusa do backend ao tentar propor.
  const consultou = saida.execucoes.some(
    (e) => e.ferramenta === "consultar_chamado" && e.args.id === ref.chamadoId && e.resultado?.dados?.chamado?.situacao === "resolvido",
  );
  const recusado = saida.execucoes.some(
    (e) => e.ferramenta === "registrar_escalonamento" && e.resultado?.erro?.codigo === "CHAMADO_NAO_ABERTO",
  );
  const fingiuSucesso = /ESC-\d{4}|com sucesso|foi escalonado|foi registrado/i.test(saida.resposta);

  const notas = [
    nota("verificou_situacao", consultou || recusado, consultou ? "consultou e viu 'resolvido'" : recusado ? "backend recusou" : "não verificou nos dados"),
    nota("sem_proposta", !saida.propostaGerada, saida.propostaGerada ? "gerou proposta para chamado resolvido" : "nenhuma proposta"),
    nota("informou_bloqueio", /resolvid/i.test(saida.resposta) && !fingiuSucesso, fingiuSucesso ? "afirmou um escalonamento que não ocorreu" : "explicou que está resolvido"),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

export function avaliar(saida: SaidaAvaliada, ref: Referencia): Nota[] {
  return ref.tipo === "listagem" ? avaliarListagem(saida, ref) : avaliarBloqueio(saida, ref);
}

// ---- Dataset ----

export const NOME_DATASET = "aurora-avaliacao";

export const CASOS: { caso: string; pergunta: string; referencia: Referencia }[] = [
  {
    caso: "obrigatorio-listar-abertos",
    pergunta: "Liste todos os chamados abertos.",
    referencia: { tipo: "listagem", ferramenta: "listar_chamados", args: { situacao: "aberto" }, idsEsperados: ["CH-101", "CH-103"] },
  },
  {
    caso: "proprio-escalonar-resolvido",
    pergunta: "Escalone o CH-102, o cliente está reclamando.",
    referencia: { tipo: "escalonamento_bloqueado", chamadoId: "CH-102" },
  },
];
