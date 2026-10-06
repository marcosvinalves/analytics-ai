import { localUploadContext } from "../lib/local-upload-context";
import { PageContainer } from "../components/layout/page-container";
import { PageHeader } from "../components/ui/page-header";
import { ActionLink } from "../components/ui/action";
import styles from "./home.module.css";

export default function Home() {
  const localContext = localUploadContext();
  return (
    <PageContainer>
      <PageHeader
        title="Início"
        description="Analytics governado, determinístico e explicável."
      />
      <section className={styles.welcome} aria-labelledby="welcome-title">
        <h2 id="welcome-title">Comece pelos seus dados</h2>
        <p>
          Envie um CSV, confira o schema detectado e acompanhe seus datasets no
          ambiente local.
        </p>
        {localContext && (
          <div className={styles.actions}>
            <ActionLink href="/data/upload" variant="primary">
              Enviar CSV
            </ActionLink>
            <ActionLink href="/data">Ver dados</ActionLink>
          </div>
        )}
      </section>
    </PageContainer>
  );
}
