import Link from "next/link";
import { localUploadContext } from "../lib/local-upload-context";

export default function Home() {
  return (
    <main>
      <h1>Analytics AI</h1>
      <p>Technical Alpha</p>
      {localUploadContext() && (
        <p>
          <Link href="/data">Dados</Link>
          {" · "}
          <Link href="/data/upload">Enviar CSV</Link>
        </p>
      )}
    </main>
  );
}
