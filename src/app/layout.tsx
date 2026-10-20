import "./globals.css";

export const metadata = { title: "Aurora | Assistente de Suporte" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
