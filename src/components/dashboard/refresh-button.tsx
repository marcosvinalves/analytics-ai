"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import styles from "./dashboard.module.css";
import { Button } from "../ui/action";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className={styles.refresh} aria-live="polite">
      <Button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {pending ? "Atualizando…" : "Atualizar"}
      </Button>
      <span className="sr-only">
        {pending ? "Atualização do Dashboard em andamento." : ""}
      </span>
    </div>
  );
}
