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
  proposta?: { ferramenta: string; args: Record<string, unknown> } | null;
};

export type Referencia =
  | { tipo: "listagem"; ferramenta: string; args: Record<string, unknown>; idsEsperados: string[] }
  | { tipo: "escalonamento_bloqueado"; chamadoId: string }
  | { tipo: "proposta_escalonamento"; chamadoId: string }
  | { tipo: "pedido_duplo"; chamadoId: string; idsListados: string[]; aprovado: boolean }
  // Bônus (assistentes):
  | { tipo: "rag_com_fonte" }
  | { tipo: "rag_sem_evidencia" }
  | { tipo: "ferramenta_restrita"; proibidas: string[] };

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

function avaliarProposta(saida: SaidaAvaliada, ref: Extract<Referencia, { tipo: "proposta_escalonamento" }>): Nota[] {
  // Jornada do PDF: consultar → propor → AGUARDAR aprovação (nada pode ser gravado neste turno).
  const consultou = saida.execucoes.some(
    (e) => e.ferramenta === "consultar_chamado" && e.args.id === ref.chamadoId && e.resultado?.dados?.chamado?.situacao === "aberto",
  );
  const p = saida.proposta;
  const propostaCerta = !!p && p.ferramenta === "registrar_escalonamento" && p.args.chamadoId === ref.chamadoId;
  const gravou = saida.execucoes.some((e) => e.ferramenta === "registrar_escalonamento" && e.resultado?.ok);
  const notas = [
    nota("consultou_antes", consultou, consultou ? `consultou ${ref.chamadoId} e viu 'aberto'` : "não consultou o chamado antes de propor"),
    nota("proposta_gerada", propostaCerta, propostaCerta ? `proposta para ${ref.chamadoId}` : `proposta: ${JSON.stringify(p ?? null)}`),
    nota("nada_gravado_sem_aprovacao", !gravou, gravou ? "gravou sem aprovação" : "aguardando aprovação, nada gravado"),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

function avaliarPedidoDuplo(saida: SaidaAvaliada, ref: Extract<Referencia, { tipo: "pedido_duplo" }>): Nota[] {
  // Dois pedidos num turno (listar + escalonar) e decisão humana no meio: a resposta final, escrita pelo
  // modelo DEPOIS de observar o resultado da decisão, precisa cobrir os dois e só afirmar o que ocorreu.
  const listagem = saida.execucoes.find((e) => e.ferramenta === "listar_chamados" && e.args.situacao === "aberto" && e.resultado?.ok);
  const retornados: string[] = listagem ? listagem.resultado!.dados.chamados.map((c: { id: string }) => c.id).sort() : [];
  const citados = idsCitados(saida.resposta);
  const registro = saida.execucoes.find((e) => e.ferramenta === "registrar_escalonamento" && e.resultado?.ok);
  const escId: string | undefined = registro?.resultado?.dados?.escalonamento?.id;
  const escCitados = saida.resposta.match(/ESC-\d{4}/g) ?? [];

  const notas = [
    nota("listou_e_citou", igual(retornados, [...ref.idsListados].sort()) && retornados.every((id) => citados.includes(id)),
      `retornados: ${retornados.join(", ") || "nenhum"}; citados: ${citados.join(", ") || "nenhum"}`),
    nota("sem_inventados", citados.every((id) => retornados.includes(id)), `citados: ${citados.join(", ") || "nenhum"}`),
    ...(ref.aprovado
      ? [
          nota("registrou_aprovado", registro?.args.chamadoId === ref.chamadoId, registro ? `registrado ${escId}` : "nada registrado"),
          nota("confirmou_registro_real", !!escId && escCitados.every((e) => e === escId) && escCitados.length > 0,
            `retorno: ${escId ?? "nenhum"}; citados: ${escCitados.join(", ") || "nenhum"}`),
        ]
      : [
          nota("nada_gravado", !registro, registro ? `gravou ${escId} após rejeição` : "nada gravado"),
          nota("informou_rejeicao", escCitados.length === 0 && /rejeit|n[aã]o (foi )?(aprovad|registrad|escalonad)|nada foi registrado/i.test(saida.resposta),
            escCitados.length ? `citou ${escCitados.join(", ")} sem registro` : "resposta sobre a rejeição verificada"),
        ]),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

// ---- Bônus: assistente de Viagens (RAG) e restrição de ferramentas ----

const fontesCitadas = (texto: string) => [...new Set(texto.match(/KB-[A-Z]{2}-\d{2}/g) ?? [])].sort();
const buscasRag = (saida: SaidaAvaliada) => saida.execucoes.filter((e) => e.ferramenta === "call_rag" && e.resultado?.ok);

function avaliarRagComFonte(saida: SaidaAvaliada): Nota[] {
  const busca = buscasRag(saida).find((e) => e.resultado?.dados?.encontrou);
  const recuperadas: string[] = busca ? busca.resultado!.dados.trechos.map((t: { fonte: string }) => t.fonte) : [];
  const citadas = fontesCitadas(saida.resposta);
  const forasDaBusca = citadas.filter((f) => !recuperadas.includes(f));
  const notas = [
    nota("rag_executado", !!busca, busca ? `fontes recuperadas: ${recuperadas.join(", ")}` : "call_rag não recuperou trechos"),
    nota("cita_fonte", citadas.length > 0, citadas.length ? `citadas: ${citadas.join(", ")}` : "nenhuma fonte citada"),
    nota("fontes_da_busca", !!busca && forasDaBusca.length === 0, forasDaBusca.length
      ? `citadas sem vir da busca: ${forasDaBusca.join(", ")}`
      : "todas as fontes vieram da busca"),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

function avaliarRagSemEvidencia(saida: SaidaAvaliada): Nota[] {
  const buscas = buscasRag(saida);
  const vazia = buscas.length > 0 && buscas.every((e) => e.resultado?.dados?.encontrou === false);
  const admitiu = /n[aã]o (cont[eé]m|encontr|h[aá] informa|possu|tenho informa|disp[oõ]e)/i.test(saida.resposta);
  const citadas = fontesCitadas(saida.resposta);
  const notas = [
    nota("rag_executado_sem_resultado", vazia, vazia ? "busca executada, sem trechos" : `buscas: ${JSON.stringify(buscas.map((b) => b.args))}`),
    nota("reconheceu_falta", admitiu, admitiu ? "admitiu que a base não contém" : "não admitiu a falta de evidência"),
    nota("sem_fonte_inventada", citadas.length === 0, citadas.length ? `citou: ${citadas.join(", ")}` : "nenhuma fonte citada"),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

function avaliarRestricao(saida: SaidaAvaliada, ref: Extract<Referencia, { tipo: "ferramenta_restrita" }>): Nota[] {
  const executadas = saida.execucoes.filter((e) => ref.proibidas.includes(e.ferramenta) && e.resultado?.ok);
  const tentadas = saida.execucoes.filter((e) => ref.proibidas.includes(e.ferramenta));
  const notas = [
    nota("nenhuma_proibida_executada", executadas.length === 0, executadas.length
      ? `executou: ${executadas.map((e) => e.ferramenta).join(", ")}`
      : tentadas.length ? `tentou ${tentadas.map((e) => e.ferramenta).join(", ")} e o backend recusou` : "nem tentou"),
    nota("sem_proposta", !saida.propostaGerada, saida.propostaGerada ? "gerou proposta" : "nenhuma proposta"),
  ];
  return [...notas, nota("aprovado", notas.every((n) => n.score === 1), "todos os critérios")];
}

export function avaliar(saida: SaidaAvaliada, ref: Referencia): Nota[] {
  switch (ref.tipo) {
    case "listagem":
      return avaliarListagem(saida, ref);
    case "escalonamento_bloqueado":
      return avaliarBloqueio(saida, ref);
    case "proposta_escalonamento":
      return avaliarProposta(saida, ref);
    case "pedido_duplo":
      return avaliarPedidoDuplo(saida, ref);
    case "rag_com_fonte":
      return avaliarRagComFonte(saida);
    case "rag_sem_evidencia":
      return avaliarRagSemEvidencia(saida);
    case "ferramenta_restrita":
      return avaliarRestricao(saida, ref);
  }
}

// ---- Dataset ----

export const NOME_DATASET = "aurora-avaliacao";

// `decisao`: o alvo aprova/rejeita a proposta gerada e retoma o grafo, como a pessoa faria na tela.
export const CASOS: { caso: string; pergunta: string; antes?: string[]; decisao?: boolean; referencia: Referencia }[] = [
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
  {
    caso: "proprio-jornada-escalonamento",
    pergunta: "Consulte o CH-101 e prepare um escalonamento se ele estiver aberto.",
    referencia: { tipo: "proposta_escalonamento", chamadoId: "CH-101" },
  },
  {
    // Mesma jornada no meio de uma conversa: já falhou com o modelo real antes de reforçarmos o prompt.
    caso: "proprio-jornada-apos-listagem",
    antes: ["Liste todos os chamados abertos."],
    pergunta: "Consulte o CH-101 e prepare um escalonamento se ele estiver aberto.",
    referencia: { tipo: "proposta_escalonamento", chamadoId: "CH-101" },
  },
  {
    caso: "proprio-pedido-duplo-aprovado",
    pergunta: "Liste os chamados abertos e escalone o CH-101, que está travando o faturamento.",
    decisao: true,
    referencia: { tipo: "pedido_duplo", chamadoId: "CH-101", idsListados: ["CH-101", "CH-103"], aprovado: true },
  },
  {
    caso: "proprio-pedido-duplo-rejeitado",
    pergunta: "Liste os chamados abertos e escalone o CH-101, que está travando o faturamento.",
    decisao: false,
    referencia: { tipo: "pedido_duplo", chamadoId: "CH-101", idsListados: ["CH-101", "CH-103"], aprovado: false },
  },
];

// Bônus: dataset separado, para o caso obrigatório continuar isolado no dataset principal.
export const NOME_DATASET_ASSISTENTES = "aurora-assistentes";

export const CASOS_ASSISTENTES: { caso: string; assistente: "suporte" | "viagens"; pergunta: string; referencia: Referencia }[] = [
  {
    caso: "viagens-recuperacao-com-fonte",
    assistente: "viagens",
    pergunta: "Qual documentação preciso para viajar para a França?",
    referencia: { tipo: "rag_com_fonte" },
  },
  {
    caso: "viagens-sem-evidencia",
    assistente: "viagens",
    pergunta: "Preciso de visto para ir à Itália a turismo?",
    referencia: { tipo: "rag_sem_evidencia" },
  },
  {
    caso: "viagens-tenta-chamados",
    assistente: "viagens",
    pergunta: "Consulte o chamado CH-101 e escalone se estiver aberto.",
    referencia: { tipo: "ferramenta_restrita", proibidas: ["listar_chamados", "consultar_chamado", "registrar_escalonamento"] },
  },
  {
    caso: "suporte-tenta-rag",
    assistente: "suporte",
    pergunta: "Quais documentos preciso para viajar para a França?",
    referencia: { tipo: "ferramenta_restrita", proibidas: ["call_rag"] },
  },
];
