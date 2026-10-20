import { z } from "zod";

// Dados 100% fictícios da empresa Aurora, criados para o desafio técnico.

export const SituacaoSchema = z.enum(["aberto", "resolvido"]);
export type Situacao = z.infer<typeof SituacaoSchema>;

export const ChamadoIdSchema = z
  .string()
  .regex(/^CH-\d{3}$/, "Identificador deve seguir o formato CH-000");

// Contrato de um chamado. É usado também para validar a SAÍDA das ferramentas:
// se algum dado sair fora deste formato, tratamos como "saída inválida".
export const ChamadoSchema = z.object({
  id: ChamadoIdSchema,
  titulo: z.string().min(1),
  descricao: z.string().min(1),
  cliente: z.string().min(1),
  situacao: SituacaoSchema,
  prioridade: z.enum(["baixa", "media", "alta", "critica"]),
  abertoEm: z.iso.datetime(),
});
export type Chamado = z.infer<typeof ChamadoSchema>;

// parse() no carregamento: se alguém editar o mock e quebrar o contrato,
// a aplicação falha na hora em vez de servir dado inválido.
export const CHAMADOS: readonly Readonly<Chamado>[] = Object.freeze(
  z.array(ChamadoSchema).parse([
    {
      id: "CH-101",
      titulo: "Erro 500 ao emitir nota fiscal",
      descricao: "Desde a atualização de ontem, a emissão de NF-e retorna erro 500 para todos os usuários da filial Sul.",
      cliente: "Padaria Estrela do Norte (fictícia)",
      situacao: "aberto",
      prioridade: "alta",
      abertoEm: "2026-10-12T09:15:00Z",
    },
    {
      id: "CH-102",
      titulo: "Redefinição de senha não chega por e-mail",
      descricao: "Usuário não recebia o e-mail de redefinição. Causa: filtro de spam do cliente. Liberado o remetente.",
      cliente: "Clínica Vida Plena (fictícia)",
      situacao: "resolvido",
      prioridade: "media",
      abertoEm: "2026-10-10T14:02:00Z",
    },
    {
      id: "CH-103",
      titulo: "Relatório mensal com valores duplicados",
      descricao: "O relatório de vendas de setembro soma duas vezes os pedidos cancelados e reabertos.",
      cliente: "Mercado Bom Preço (fictício)",
      situacao: "aberto",
      prioridade: "media",
      abertoEm: "2026-10-14T11:40:00Z",
    },
    {
      id: "CH-104",
      titulo: "Dúvida sobre exportação para CSV",
      descricao: "Cliente perguntou como exportar a lista de produtos. Enviado o passo a passo da documentação.",
      cliente: "Livraria Página Viva (fictícia)",
      situacao: "resolvido",
      prioridade: "baixa",
      abertoEm: "2026-10-08T16:20:00Z",
    },
  ]).map((c) => Object.freeze(c)),
);
