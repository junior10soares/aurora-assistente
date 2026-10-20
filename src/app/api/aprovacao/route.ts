import { DecisaoHttpSchema, responder, servico } from "../../../lib/servidor";

export async function POST(req: Request) {
  return responder(async () => {
    const { assistente, sessaoId, propostaId, decisao } = DecisaoHttpSchema.parse(await req.json());
    return servico().decidir(sessaoId, propostaId, decisao === "aprovar", assistente);
  });
}
