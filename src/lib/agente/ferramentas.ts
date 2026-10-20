import { z } from "zod";
import { CHAMADOS, ChamadoSchema, SituacaoSchema } from "../aurora/chamados";
import { AVISO_SIMULACAO, buscar } from "../viagens/base";

// Erro de negócio/execução com código estável (o modelo e os testes leem o código, não a mensagem).
// `transitorio` diz ao executor se vale a pena tentar de novo.
export class ErroFerramenta extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly transitorio = false,
  ) {
    super(mensagem);
    this.name = codigo; // no rastro do LangSmith o erro aparece como "CODIGO: mensagem"
  }
}

// Aceita "ch-101" ou " CH-101 " e normaliza antes de validar o formato.
const IdChamadoEntrada = z.string().trim().toUpperCase().regex(/^CH-\d{3}$/, "Formato esperado: CH-000");

function buscarChamado(id: string) {
  const chamado = CHAMADOS.find((c) => c.id === id);
  if (!chamado) throw new ErroFerramenta("CHAMADO_INEXISTENTE", `Chamado ${id} não existe.`);
  return chamado;
}

// Regra de negócio no backend: usada antes de propor E de novo ao registrar.
export function verificarEscalonavel(chamadoId: string) {
  const chamado = buscarChamado(chamadoId);
  if (chamado.situacao !== "aberto") {
    throw new ErroFerramenta(
      "CHAMADO_NAO_ABERTO",
      `Chamado ${chamadoId} está "${chamado.situacao}". Somente chamados abertos podem ser escalonados.`,
    );
  }
}

// ---- Registro de escalonamentos (simulado, em memória) ----

const EntradaEscalonamento = z.object({
  chamadoId: IdChamadoEntrada.describe("Identificador do chamado, ex.: CH-101"),
  resumo: z.string().trim().min(10).max(1000).describe("Resumo objetivo do problema"),
  justificativa: z.string().trim().min(10).max(1000).describe("Por que o chamado precisa ser escalonado"),
});
type EntradaEscalonamento = z.infer<typeof EntradaEscalonamento>;

export const EscalonamentoSchema = z.object({
  id: z.string().regex(/^ESC-\d{4}$/),
  chamadoId: z.string(),
  resumo: z.string(),
  justificativa: z.string(),
  registradoEm: z.iso.datetime(),
});
export type Escalonamento = z.infer<typeof EscalonamentoSchema>;

// ponytail: Map em memória (some ao reiniciar o servidor); banco com UNIQUE(chave) se houver persistência.
const registros = new Map<string, { entrada: EntradaEscalonamento; escalonamento: Escalonamento }>();

function registrarEscalonamento(entrada: EntradaEscalonamento, chave: string) {
  // Idempotência: a mesma chave (propostaId) devolve o registro existente, sem duplicar.
  // Verificar e gravar acontecem no mesmo trecho síncrono, então duas aprovações simultâneas não "correm".
  const existente = registros.get(chave);
  if (existente) {
    if (JSON.stringify(existente.entrada) !== JSON.stringify(entrada)) {
      throw new ErroFerramenta("CONFLITO_IDEMPOTENCIA", "A chave já foi usada para outro conteúdo.");
    }
    return { escalonamento: existente.escalonamento, jaRegistrado: true };
  }
  verificarEscalonavel(entrada.chamadoId);
  const escalonamento: Escalonamento = {
    id: `ESC-${String(registros.size + 1).padStart(4, "0")}`,
    ...entrada,
    registradoEm: new Date().toISOString(),
  };
  registros.set(chave, { entrada, escalonamento });
  return { escalonamento, jaRegistrado: false };
}

export function listarEscalonamentos(): Escalonamento[] {
  return [...registros.values()].map((r) => r.escalonamento);
}

export function limparEscalonamentos() {
  registros.clear();
}

// ---- Catálogo de ferramentas ----

type Contexto = { chaveIdempotencia?: string };

export type Ferramenta<E extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> = {
  descricao: string;
  entrada: E;
  saida: S;
  // Ferramentas que escrevem: o executor só roda com aprovação humana vinculada.
  exigeAprovacao?: boolean;
  // Checagem de regra de negócio feita ANTES de gerar a proposta.
  preValidar?: (args: z.infer<E>) => void;
  executar: (args: z.infer<E>, ctx: Contexto) => z.infer<S>;
};

const definir = <E extends z.ZodType, S extends z.ZodType>(f: Ferramenta<E, S>) => f as unknown as Ferramenta;

export const FERRAMENTAS: Record<string, Ferramenta> = {
  listar_chamados: definir({
    descricao: "Lista os chamados da Aurora. Use o argumento situacao para filtrar (ex.: abertos).",
    entrada: z.object({
      situacao: SituacaoSchema.optional().describe("Filtra pela situação do chamado; omita para listar todos"),
    }),
    saida: z.object({ chamados: z.array(ChamadoSchema) }),
    executar: ({ situacao }) => ({
      chamados: CHAMADOS.filter((c) => !situacao || c.situacao === situacao).map((c) => ({ ...c })),
    }),
  }),

  consultar_chamado: definir({
    descricao: "Consulta um chamado da Aurora pelo identificador (ex.: CH-101).",
    entrada: z.object({ id: IdChamadoEntrada.describe("Identificador do chamado, ex.: CH-101") }),
    saida: z.object({ chamado: ChamadoSchema }),
    executar: ({ id }) => ({ chamado: { ...buscarChamado(id) } }),
  }),

  registrar_escalonamento: definir({
    descricao:
      "Registra o escalonamento de um chamado ABERTO para revisão humana, com resumo e justificativa. " +
      "Só é executado após aprovação humana da proposta.",
    entrada: EntradaEscalonamento,
    saida: z.object({ escalonamento: EscalonamentoSchema, jaRegistrado: z.boolean() }),
    exigeAprovacao: true,
    preValidar: ({ chamadoId }) => verificarEscalonavel(chamadoId),
    executar: (args, { chaveIdempotencia }) => {
      if (!chaveIdempotencia) throw new ErroFerramenta("APROVACAO_NECESSARIA", "Registro exige aprovação.");
      return registrarEscalonamento(args, chaveIdempotencia);
    },
  }),

  // Bônus: recuperação na base própria de documentação de viagem (RAG).
  call_rag: definir({
    descricao:
      "Busca trechos na base própria de documentação de viagem (conteúdo fictício). Retorna trechos com a fonte. " +
      "Informe o país sempre que a pergunta citar um.",
    entrada: z.object({
      pergunta: z.string().trim().min(3).max(500).describe("A pergunta do usuário, com os detalhes relevantes"),
      pais: z.string().trim().min(2).max(60).optional().describe("País de destino, ex.: França"),
      nacionalidade: z.string().trim().min(2).max(60).optional().describe("Nacionalidade do passaporte, ex.: brasileira"),
      finalidade: z.enum(["turismo", "negocios", "estudo"]).optional().describe("Finalidade da viagem"),
    }),
    saida: z.object({
      encontrou: z.boolean(),
      aviso: z.string(),
      trechos: z.array(
        z.object({
          fonte: z.string(),
          titulo: z.string(),
          aplicaA: z.object({ pais: z.string(), nacionalidade: z.string(), finalidade: z.string(), duracao: z.string() }),
          trecho: z.string(),
        }),
      ),
    }),
    executar: ({ pergunta, ...filtros }) => {
      const docs = buscar(pergunta, filtros);
      return {
        encontrou: docs.length > 0,
        aviso: AVISO_SIMULACAO,
        trechos: docs.map((d) => ({
          fonte: d.fonte,
          titulo: d.titulo,
          aplicaA: { pais: d.pais, nacionalidade: d.nacionalidade, finalidade: d.finalidade, duracao: d.duracao },
          trecho: d.conteudo,
        })),
      };
    },
  }),
};
