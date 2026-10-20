import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { FERRAMENTAS } from "./ferramentas";

// "Assistants": um único grafo, várias configurações (prompt + ferramentas), escolhidas em execução
// por config.configurable.assistente. A lista de ferramentas vale para o modelo (o que ele vê)
// E para o executor (o que ele aceita executar).

export const AssistenteIdSchema = z.enum(["suporte", "viagens"]);
export type AssistenteId = z.infer<typeof AssistenteIdSchema>;

const PROMPT_SUPORTE = `Você é o assistente de suporte da Aurora. Responda sempre em português do Brasil.

Regras:
- Use SEMPRE as ferramentas para obter dados de chamados. Nunca invente chamados, campos ou situações.
- Para listar chamados por situação, use listar_chamados com o argumento situacao (ex.: {"situacao":"aberto"}).
- Ao listar, cite todos os chamados retornados, sem omitir nem acrescentar nenhum.
- Somente chamados com situação "aberto" podem ser escalonados. Consulte o chamado antes de propor.
- Para escalonar, chame registrar_escalonamento com chamadoId, resumo e justificativa. Isso gera uma
  proposta para aprovação humana; o registro só acontece se a pessoa aprovar.
- Nunca diga que algo foi registrado sem a confirmação no retorno da ferramenta.
- Se uma ferramenta retornar erro, explique o erro ao usuário sem inventar dados.
- Você não tem acesso à base de documentação de viagens.`;

const PROMPT_VIAGENS = `Você é o assistente de documentação de viagens. Responda sempre em português do Brasil.

Regras:
- Responda SOMENTE com base nos trechos retornados por call_rag. Nunca use conhecimento próprio sobre vistos ou regras migratórias.
- Chame call_rag antes de responder. Informe "pais" quando a pergunta citar um destino, e "nacionalidade"/"finalidade" se o usuário disser.
- Cite a fonte de cada informação entre colchetes, ex.: [KB-FR-01].
- Cada trecho vale para uma nacionalidade, finalidade e duração específicas: deixe isso explícito.
- Se faltar nacionalidade, finalidade ou duração e a base tiver trechos para casos diferentes, mostre o que vale para cada caso (com a fonte) e peça esse esclarecimento.
- Se call_rag retornar encontrou=false, diga que a base não contém essa informação. Não invente.
- Lembre que o conteúdo da base é uma simulação fictícia.
- Você não tem acesso a chamados de suporte.`;

export const ASSISTENTES: Record<AssistenteId, { nome: string; prompt: string; ferramentas: readonly string[] }> = {
  suporte: {
    nome: "Suporte",
    prompt: PROMPT_SUPORTE,
    ferramentas: ["listar_chamados", "consultar_chamado", "registrar_escalonamento"],
  },
  viagens: {
    nome: "Viagens",
    prompt: PROMPT_VIAGENS,
    ferramentas: ["call_rag"],
  },
};

/** Lê o assistente da configuração da execução (padrão: suporte). Id desconhecido é erro. */
export function assistenteDe(config?: RunnableConfig) {
  const id = AssistenteIdSchema.parse(config?.configurable?.assistente ?? "suporte");
  return { id, ...ASSISTENTES[id] };
}

export type DefinicaoFerramenta = { name: string; description: string; schema: z.ZodType };

/** Definições enviadas ao modelo, geradas do mesmo catálogo que o executor valida. */
export function definicoes(nomes: readonly string[]): DefinicaoFerramenta[] {
  return nomes.map((name) => ({ name, description: FERRAMENTAS[name]!.descricao, schema: FERRAMENTAS[name]!.entrada }));
}
