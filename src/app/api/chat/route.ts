import { MensagemSchema, responder, servico } from "../../../lib/servidor";

export async function POST(req: Request) {
  return responder(async () => {
    const { assistente, sessaoId, mensagem } = MensagemSchema.parse(await req.json());
    return servico().enviarMensagem(sessaoId, mensagem, assistente);
  });
}
