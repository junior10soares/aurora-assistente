"use client";

import { useEffect, useRef, useState } from "react";
import type { ItemConversa, VisaoSessao } from "../lib/servidor";

const CHAVE_SESSAO = "aurora.sessaoId";

type Assistente = "suporte" | "viagens";
const ASSISTENTES: Record<Assistente, { nome: string; exemplos: string }> = {
  suporte: {
    nome: "Suporte",
    exemplos: "“Liste todos os chamados abertos.” ou “Consulte o CH-101 e prepare um escalonamento se ele estiver aberto.”",
  },
  viagens: {
    nome: "Viagens",
    exemplos: "“Qual documentação preciso para viajar para a França?” (base fictícia, apenas simulação)",
  },
};

// localStorage pode falhar (aba anônima, bloqueio): a tela funciona mesmo assim.
function lerSessao(): string {
  try {
    const salva = localStorage.getItem(CHAVE_SESSAO);
    if (salva) return salva;
  } catch {}
  return novaSessao();
}

function novaSessao(): string {
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(CHAVE_SESSAO, id);
  } catch {}
  return id;
}

async function chamarApi(url: string, corpo?: unknown): Promise<VisaoSessao> {
  const resp = await fetch(url, corpo ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) } : {});
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.erro ?? `Erro ${resp.status}`);
  return json;
}

const ROTULOS: Record<string, string> = { chamadoId: "Chamado", resumo: "Resumo", justificativa: "Justificativa" };

export default function Home() {
  const [sessaoId, setSessaoId] = useState<string | null>(null);
  const [assistente, setAssistente] = useState<Assistente>("suporte");
  const [visao, setVisao] = useState<VisaoSessao | null>(null);
  const [texto, setTexto] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => setSessaoId(lerSessao()), []);

  // Cada assistente tem o próprio histórico na mesma sessão: ao trocar, carrega o dele.
  useEffect(() => {
    if (sessaoId) executar(() => chamarApi(`/api/sessao?sessaoId=${sessaoId}&assistente=${assistente}`));
  }, [sessaoId, assistente]);

  useEffect(() => fim.current?.scrollIntoView({ behavior: "smooth" }), [visao]);

  async function executar(acao: () => Promise<VisaoSessao>) {
    setCarregando(true);
    setAviso(null);
    try {
      setVisao(await acao());
    } catch (e) {
      setAviso((e as Error).message);
      // Recarrega o estado real do servidor (ex.: proposta já decidida em outra aba).
      if (sessaoId) chamarApi(`/api/sessao?sessaoId=${sessaoId}&assistente=${assistente}`).then(setVisao, () => {});
    } finally {
      setCarregando(false);
    }
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    const mensagem = texto.trim();
    if (!mensagem || !sessaoId) return;
    setTexto("");
    executar(() => chamarApi("/api/chat", { assistente, sessaoId, mensagem }));
  }

  function decidir(decisao: "aprovar" | "rejeitar") {
    if (!sessaoId || !visao?.proposta) return;
    executar(() => chamarApi("/api/aprovacao", { assistente, sessaoId, propostaId: visao.proposta!.propostaId, decisao }));
  }

  function reiniciar() {
    setVisao(null);
    setAviso(null);
    setSessaoId(novaSessao());
  }

  const proposta = visao?.proposta;

  return (
    <main className="app">
      <header className="topo">
        <div>
          <h1>Aurora · Assistentes</h1>
          <p className="sessao">Sessão: {sessaoId ?? "…"}</p>
        </div>
        <div className="seletor" role="group" aria-label="Assistente">
          {(Object.keys(ASSISTENTES) as Assistente[]).map((id) => (
            <button
              key={id}
              type="button"
              className={id === assistente ? "" : "secundario"}
              aria-pressed={id === assistente}
              onClick={() => setAssistente(id)}
              disabled={carregando}
            >
              {ASSISTENTES[id].nome}
            </button>
          ))}
        </div>
        <button type="button" className="secundario" onClick={reiniciar} disabled={carregando}>
          Nova conversa
        </button>
      </header>

      <section className="conversa" aria-live="polite">
        {!visao?.itens.length && (
          <p className="vazio">Experimente: {ASSISTENTES[assistente].exemplos}</p>
        )}
        {visao?.itens.map((item, i) => <Item key={i} item={item} />)}
        {carregando && <p className="pensando">Processando…</p>}
        <div ref={fim} />
      </section>

      {proposta && (
        <section className="proposta" aria-label="Proposta aguardando aprovação">
          <h2>Proposta de escalonamento: aguardando sua decisão</h2>
          <dl>
            {Object.entries(proposta.args).map(([campo, valor]) => (
              <div key={campo}>
                <dt>{ROTULOS[campo] ?? campo}</dt>
                <dd>{String(valor)}</dd>
              </div>
            ))}
          </dl>
          <p className="id-proposta">Proposta {proposta.propostaId}</p>
          <div className="acoes">
            <button type="button" onClick={() => decidir("aprovar")} disabled={carregando}>
              Aprovar
            </button>
            <button type="button" className="perigo" onClick={() => decidir("rejeitar")} disabled={carregando}>
              Rejeitar
            </button>
          </div>
        </section>
      )}

      {aviso && (
        <p className="aviso" role="alert">
          {aviso}
        </p>
      )}

      <form className="entrada" onSubmit={enviar}>
        <label htmlFor="mensagem" className="oculto">
          Mensagem
        </label>
        <input
          id="mensagem"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={proposta ? "Decida a proposta acima antes de continuar" : "Digite sua solicitação…"}
          disabled={carregando || !!proposta || !sessaoId}
          maxLength={2000}
          autoComplete="off"
        />
        <button type="submit" disabled={carregando || !!proposta || !texto.trim()}>
          Enviar
        </button>
      </form>
    </main>
  );
}

function Item({ item }: { item: ItemConversa }) {
  switch (item.tipo) {
    case "usuario":
      return <p className="balao usuario">{item.texto}</p>;
    case "assistente":
      return <p className="balao assistente">{item.texto}</p>;
    case "chamada":
      return (
        <p className="ferramenta">
          🔧 {item.ferramenta} <code>{JSON.stringify(item.args)}</code>
        </p>
      );
    case "resultado":
      return (
        <p className={`ferramenta ${item.ok ? "ok" : "falha"}`}>
          {item.ok ? "✓" : "✗"} {item.ferramenta} {item.ok ? "executada" : item.codigo}
        </p>
      );
  }
}
