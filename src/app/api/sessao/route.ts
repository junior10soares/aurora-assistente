import { z } from "zod";
import { AssistenteIdSchema } from "../../../lib/agente/assistentes";
import { responder, servico } from "../../../lib/servidor";

export async function GET(req: Request) {
  return responder(async () => {
    const params = new URL(req.url).searchParams;
    const sessaoId = z.uuid().parse(params.get("sessaoId"));
    const assistente = AssistenteIdSchema.parse(params.get("assistente") ?? "suporte");
    return servico().verSessao(sessaoId, assistente);
  });
}
