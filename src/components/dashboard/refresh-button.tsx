"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import styles from "./dashboard.module.css";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className={styles.refresh} aria-live="polite">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {pending ? "Atualizando…" : "Atualizar"}
      </button>
      <span className="sr-only">
        {pending ? "Atualização do Dashboard em andamento." : ""}
      </span>
    </div>
  );
}
