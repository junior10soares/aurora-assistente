import { describe, expect, it } from "vitest";
import { CHAMADOS } from "./chamados";

describe("massa fictícia de chamados", () => {
  it("contém os casos exigidos pelo desafio", () => {
    const situacao = Object.fromEntries(CHAMADOS.map((c) => [c.id, c.situacao]));
    expect(situacao).toMatchObject({ "CH-101": "aberto", "CH-102": "resolvido", "CH-103": "aberto" });
  });

  it("tem exatamente CH-101 e CH-103 abertos (base do caso de avaliação)", () => {
    expect(CHAMADOS.filter((c) => c.situacao === "aberto").map((c) => c.id)).toEqual(["CH-101", "CH-103"]);
  });

  it("é imutável", () => {
    expect(() => {
      (CHAMADOS[0] as { situacao: string }).situacao = "resolvido";
    }).toThrow();
  });
});
