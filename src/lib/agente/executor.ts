import { randomUUID } from "node:crypto";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { ErroFerramenta, FERRAMENTAS, type Ferramenta } from "./ferramentas";

// O executor é o "porteiro": todo pedido de ferramenta vindo do modelo passa por aqui.
// As regras de segurança vivem no código, não no prompt.

export const LIMITES = {
  timeoutMs: 2000, // tempo máximo de UMA tentativa
  maxTentativas: 3, // total de tentativas para erros transitórios
  esperaEntreTentativasMs: 200, // espera cresce a cada tentativa (200, 400...)
};
export type Limites = typeof LIMITES;

export type ErroExecucao = { codigo: string; mensagem: string };

export type ResultadoFerramenta =
  | { ok: true; ferramenta: string; dados: unknown; tentativas: number }
  | { ok: false; ferramenta: string; erro: ErroExecucao; tentativas: number };

// O que o humano vê e aprova. Ao aprovar, executamos EXATAMENTE estes args.
export type Proposta = { propostaId: string; ferramenta: string; args: Record<string, unknown> };

// ---- Simulação de falhas (usada nos testes e no roteiro de demonstração) ----

export type FalhaSimulada = "transitoria" | "lenta" | "saida_invalida";
const falhasSimuladas = new Map<string, FalhaSimulada[]>();

/** Enfileira falhas para as próximas tentativas da ferramenta (uma falha por tentativa). */
export function simularFalhas(ferramenta: string, ...falhas: FalhaSimulada[]) {
  falhasSimuladas.set(ferramenta, [...(falhasSimuladas.get(ferramenta) ?? []), ...falhas]);
}

export function limparSimulacoes() {
  falhasSimuladas.clear();
}

// ---- Funções internas ----

const dormir = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function obter(nome: string, permitidas?: readonly string[]): Ferramenta {
  // hasOwn evita que nomes como "__proto__" ou "constructor" passem pela lista permitida.
  const ferramenta = Object.hasOwn(FERRAMENTAS, nome) ? FERRAMENTAS[nome] : undefined;
  if (!ferramenta) {
    throw new ErroFerramenta("FERRAMENTA_DESCONHECIDA", `Ferramenta "${nome}" não existe ou não é permitida.`);
  }
  // Existe, mas não pertence ao assistente desta execução (ex.: Viagens pedindo consultar_chamado).
  if (permitidas && !permitidas.includes(nome)) {
    throw new ErroFerramenta("FERRAMENTA_NAO_PERMITIDA", `Ferramenta "${nome}" não está disponível para este assistente.`);
  }
  return ferramenta;
}

function validarEntrada(ferramenta: Ferramenta, args: unknown) {
  const r = ferramenta.entrada.safeParse(args);
  if (!r.success) throw new ErroFerramenta("ENTRADA_INVALIDA", z.prettifyError(r.error));
  return r.data;
}

// Erros desconhecidos viram mensagem genérica: não vazamos detalhes internos para o modelo.
function paraErro(e: unknown): ErroFerramenta {
  return e instanceof ErroFerramenta ? e : new ErroFerramenta("FALHA_INESPERADA", "Falha inesperada na ferramenta.");
}

function comTimeout<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new ErroFerramenta("TIMEOUT", `Excedeu ${ms} ms.`, true)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

async function tentar(nome: string, ferramenta: Ferramenta, args: unknown, chave: string | undefined, limites: Limites) {
  const falha = falhasSimuladas.get(nome)?.shift();
  if (falha === "transitoria") throw new ErroFerramenta("FALHA_TRANSITORIA", "Falha temporária simulada.", true);
  if (falha === "saida_invalida") return { corrompido: true };
  // "lenta": demora mais que o timeout e só depois executa (como um serviço real atrasado).
  if (falha === "lenta") await dormir(limites.timeoutMs + 100);
  return ferramenta.executar(args, { chaveIdempotencia: chave });
}

// ---- API pública ----

export function exigeAprovacao(nome: string): boolean {
  return Object.hasOwn(FERRAMENTAS, nome) && FERRAMENTAS[nome]?.exigeAprovacao === true;
}

/**
 * Para ferramentas que escrevem: valida tudo e monta a proposta, SEM executar.
 * Inclui a regra de negócio (ex.: só chamados abertos), então uma proposta inválida nem chega ao humano.
 */
export async function prepararProposta(
  nome: string,
  args: unknown,
  permitidas?: readonly string[],
): Promise<{ ok: true; proposta: Proposta } | { ok: false; erro: ErroExecucao }> {
  // Rastreado no LangSmith como "preparar_proposta": entrada = pedido do modelo; saída = proposta ou erro.
  const preparar = traceable(
    async (_pedido: { ferramenta: string; args: unknown }): Promise<Proposta> => {
      const ferramenta = obter(nome, permitidas);
      const dados = validarEntrada(ferramenta, args);
      ferramenta.preValidar?.(dados);
      return { propostaId: randomUUID(), ferramenta: nome, args: dados as Record<string, unknown> };
    },
    { name: "preparar_proposta", run_type: "tool" },
  );
  try {
    return { ok: true, proposta: await preparar({ ferramenta: nome, args }) };
  } catch (e) {
    const erro = paraErro(e);
    return { ok: false, erro: { codigo: erro.codigo, mensagem: erro.message } };
  }
}

/**
 * Executa uma ferramenta com: lista permitida, validação de entrada e saída, timeout por tentativa
 * e novas tentativas apenas para erros transitórios. Nunca lança exceção: sempre devolve um resultado.
 */
export async function executarFerramenta(
  nome: string,
  args: unknown,
  // permitidas: ferramentas do assistente da execução (o grafo sempre informa; omitido = catálogo todo).
  // prazo: instante (performance.now()) em que acaba o orçamento de execução ativa do turno.
  opcoes: {
    aprovacao?: { propostaId: string };
    limites?: Partial<Limites>;
    permitidas?: readonly string[];
    prazo?: number;
  } = {},
): Promise<ResultadoFerramenta> {
  const limites = { ...LIMITES, ...opcoes.limites };
  // A chave de idempotência é o propostaId: repetir a aprovação não duplica o registro.
  const chave = opcoes.aprovacao?.propostaId;
  let tentativas = 0;

  // Rastreado no LangSmith com o nome da ferramenta (run_type "tool"): argumentos na entrada,
  // dados na saída, ou o erro (com código) marcado em vermelho. Cada tentativa vira um filho.
  const executar = traceable(
    async (_pedido: { args: unknown; propostaId?: string }) => {
      const ferramenta = obter(nome, opcoes.permitidas);
      const dados = validarEntrada(ferramenta, args);
      if (ferramenta.exigeAprovacao && !opcoes.aprovacao) {
        throw new ErroFerramenta("APROVACAO_NECESSARIA", "Esta ferramenta só executa após aprovação humana.");
      }
      while (true) {
        // Limite TOTAL da execução: nenhuma tentativa começa ou dura além do orçamento do turno.
        const restante = (opcoes.prazo ?? Infinity) - performance.now();
        if (restante <= 0) throw new ErroFerramenta("LIMITE_TEMPO", "Limite de execução ativa do turno atingido.");
        const timeoutMs = Math.max(1, Math.floor(Math.min(limites.timeoutMs, restante)));
        tentativas++;
        try {
          const tentativa = traceable(() => comTimeout(tentar(nome, ferramenta, dados, chave, limites), timeoutMs), {
            name: `tentativa ${tentativas}`,
          });
          const validada = ferramenta.saida.safeParse(await tentativa());
          if (!validada.success) throw new ErroFerramenta("SAIDA_INVALIDA", "A ferramenta retornou dados fora do contrato.");
          return validada.data;
        } catch (e) {
          const erro = paraErro(e);
          if (!erro.transitorio) throw erro; // erro definitivo: repetir não muda o resultado
          if (tentativas >= limites.maxTentativas) {
            throw new ErroFerramenta("TENTATIVAS_ESGOTADAS", `${erro.message} Tentativas esgotadas (${tentativas}).`);
          }
          await dormir(limites.esperaEntreTentativasMs * tentativas);
        }
      }
    },
    { name: nome, run_type: "tool" },
  );

  try {
    const dados = await executar({ args, propostaId: chave });
    return { ok: true, ferramenta: nome, dados, tentativas };
  } catch (e) {
    const erro = paraErro(e);
    return { ok: false, ferramenta: nome, erro: { codigo: erro.codigo, mensagem: erro.message }, tentativas };
  }
}
