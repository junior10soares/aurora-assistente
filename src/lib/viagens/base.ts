// Base de conhecimento local do assistente de Viagens.
// ⚠️ SIMULAÇÃO: todo o conteúdo é FICTÍCIO, criado para o exercício. Não reflete regras migratórias reais.

export type Documento = {
  fonte: string; // id citado nas respostas
  titulo: string;
  pais: string;
  nacionalidade: string; // passaporte ao qual o documento se aplica
  finalidade: "turismo" | "negocios" | "estudo";
  duracao: string;
  conteudo: string;
};

export const AVISO_SIMULACAO = "Conteúdo fictício (simulação para o exercício); não use para viagens reais.";

export const DOCUMENTOS: readonly Documento[] = [
  {
    fonte: "KB-FR-01",
    titulo: "França: turismo com passaporte brasileiro (até 90 dias)",
    pais: "França",
    nacionalidade: "brasileira",
    finalidade: "turismo",
    duracao: "até 90 dias",
    conteudo:
      "[SIMULAÇÃO] Viajantes com passaporte brasileiro em turismo de até 90 dias não precisam de visto. Documentos exigidos: " +
      "passaporte válido por pelo menos 3 meses após a data de saída, seguro-viagem com cobertura mínima de 30 mil euros, " +
      "comprovante de hospedagem, passagem de volta e comprovação de meios financeiros (cerca de 120 euros por dia).",
  },
  {
    fonte: "KB-FR-02",
    titulo: "França: estudo com passaporte brasileiro (mais de 90 dias)",
    pais: "França",
    nacionalidade: "brasileira",
    finalidade: "estudo",
    duracao: "mais de 90 dias",
    conteudo:
      "[SIMULAÇÃO] Para estudar por mais de 90 dias é necessário o visto de estudante de longa duração, solicitado no consulado " +
      "antes da viagem. Documentos: carta de aceitação da instituição de ensino, comprovação financeira de 615 euros por mês, " +
      "comprovante de moradia, seguro-saúde e passaporte válido por todo o período do curso.",
  },
  {
    fonte: "KB-FR-03",
    titulo: "França: turismo com passaporte de país da União Europeia",
    pais: "França",
    nacionalidade: "países da União Europeia",
    finalidade: "turismo",
    duracao: "sem limite para turismo",
    conteudo:
      "[SIMULAÇÃO] Cidadãos da União Europeia viajam à França apenas com documento de identidade nacional válido ou passaporte. " +
      "Não há exigência de visto, seguro-viagem obrigatório nem comprovação financeira.",
  },
  {
    fonte: "KB-JP-01",
    titulo: "Japão: turismo com passaporte brasileiro (até 90 dias)",
    pais: "Japão",
    nacionalidade: "brasileira",
    finalidade: "turismo",
    duracao: "até 90 dias",
    conteudo:
      "[SIMULAÇÃO] Viajantes com passaporte brasileiro em turismo de até 90 dias precisam do visto eletrônico (eVisa), " +
      "solicitado online com 15 dias de antecedência. Documentos: passaporte válido por toda a estadia, roteiro de viagem, " +
      "reserva de hospedagem e extrato bancário dos últimos 3 meses.",
  },
  {
    fonte: "KB-JP-02",
    titulo: "Japão: negócios com passaporte brasileiro (até 90 dias)",
    pais: "Japão",
    nacionalidade: "brasileira",
    finalidade: "negocios",
    duracao: "até 90 dias",
    conteudo:
      "[SIMULAÇÃO] Viagens de negócios de até 90 dias exigem o visto de negócios de curta duração. Documentos: carta-convite " +
      "da empresa japonesa, carta da empresa brasileira descrevendo a missão, passaporte válido e comprovante de vínculo empregatício.",
  },
];

// ---- Recuperação (busca lexical com filtros) ----

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// Palavras genéricas que aparecem em quase toda pergunta/documento e não ajudam a distinguir.
const IRRELEVANTES = new Set(
  "a o as os de da do das dos e em no na nos nas um uma para por com que qual quais quero preciso precisa " +
  "viajar viagem ir vou documento documentos documentacao necessario necessaria sobre meu minha ser estar"
    .split(" "),
);

const termos = (s: string) => normalizar(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !IRRELEVANTES.has(t));

export type Filtros = { pais?: string; nacionalidade?: string; finalidade?: Documento["finalidade"] };

/**
 * Pontua cada documento pelo número de termos da pergunta presentes nele.
 * Filtro de país/finalidade é estrito: país fora da base => nenhum resultado (sem "chutar").
 */
export function buscar(pergunta: string, filtros: Filtros = {}, limite = 3) {
  const consulta = new Set(termos(pergunta));
  return DOCUMENTOS.filter((d) => !filtros.pais || normalizar(d.pais) === normalizar(filtros.pais))
    .filter((d) => !filtros.finalidade || d.finalidade === filtros.finalidade)
    .filter((d) => !filtros.nacionalidade || normalizar(d.nacionalidade).includes(normalizar(filtros.nacionalidade)))
    .map((d) => {
      const doc = new Set(termos(`${d.titulo} ${d.pais} ${d.nacionalidade} ${d.finalidade} ${d.duracao} ${d.conteudo}`));
      return { d, pontos: [...consulta].filter((t) => doc.has(t)).length };
    })
    // Com filtro de país, o país já é evidência suficiente; sem filtro, exige ao menos 2 termos em comum.
    .filter(({ pontos }) => pontos >= (filtros.pais ? 1 : 2))
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, limite)
    .map(({ d }) => d);
}
