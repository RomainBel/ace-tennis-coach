import { cn } from "@/lib/cn";

/**
 * Styles de boutons Ace — à combiner avec des classes de taille (px/py/text-sm).
 *
 * - **primary** : action principale (CTA) — plein orange.
 * - **secondary** : action secondaire — discret, bordure + fond neutre ; léger rappel orange au survol.
 * - **ghost** : lien / annuler — texte + fond au survol seulement.
 *
 * Autres idées si tu en as besoin plus tard :
 * - **outlineAccent** : bordure orange semi-transparente, texte orange, fond transparent (entre secondary et primary).
 * - **danger** : bordure rouge, texte rouge-200 (suppression compte, etc.).
 */
const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e67e22]/70";

const base = cn(
  "inline-flex shrink-0 items-center justify-center font-semibold transition select-none",
  focusRing,
  "disabled:pointer-events-none disabled:opacity-45"
);

export const buttonPrimary = cn(
  base,
  "rounded-full bg-[#e67e22] text-white shadow-lg shadow-black/35 hover:brightness-110"
);

export const buttonSecondary = cn(
  base,
  "rounded-full border border-white/12 bg-[#262626] text-neutral-300 shadow-sm",
  "hover:border-[#e67e22]/45 hover:bg-[#2f2f2f] hover:text-white",
  "active:bg-[#343434]"
);

export const buttonGhost = cn(
  base,
  "rounded-full border border-transparent bg-transparent text-neutral-400",
  "hover:border-white/10 hover:bg-white/[0.06] hover:text-neutral-100"
);
