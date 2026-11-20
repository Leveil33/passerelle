import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col justify-center gap-8">
      <header>
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">Espace commerçant</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Connexion</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">Connectez-vous pour scanner les cartes de fidélité de vos clients.</p>
      </header>
      <LoginForm />
      <p className="text-sm text-zinc-500">Mot de passe oublié ou pas encore de compte ? Contactez le responsable de la solution.</p>
    </main>
  );
}
