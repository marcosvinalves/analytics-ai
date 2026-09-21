"use client";
export default function DataError() {
  return (
    <main>
      <h1>Dados indisponíveis</h1>
      <p role="alert">
        Não foi possível carregar os dados agora. Tente novamente mais tarde.
      </p>
      <a href="/data">Voltar para Dados</a>
    </main>
  );
}
