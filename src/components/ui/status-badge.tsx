import styles from "./ui.module.css";

type Status = "PROCESSING" | "READY" | "FAILED" | "NO_VERSION";
const labels: Record<Status, string> = {
  PROCESSING: "Processando",
  READY: "Pronto",
  FAILED: "Falhou",
  NO_VERSION: "Sem versão",
};
const tones: Record<Status, string> = {
  PROCESSING: styles.processing,
  READY: styles.ready,
  FAILED: styles.failed,
  NO_VERSION: styles.neutral,
};

export function StatusBadge({ status }: { status: string }) {
  const knownStatus: Status = Object.hasOwn(labels, status)
    ? (status as Status)
    : "NO_VERSION";
  return (
    <span className={`${styles.badge} ${tones[knownStatus]}`}>
      {labels[knownStatus]}
    </span>
  );
}
