import Link from "next/link";
import { CalendarDays, MessageCircle, Trophy } from "lucide-react";

import { TennisBall } from "@/lib/tennis-ball";

function CourtBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute -right-24 -top-20 h-[28rem] w-[28rem] rounded-full bg-[#ccee33]/12 blur-[100px]" />
      <div className="absolute -bottom-32 -left-20 h-[24rem] w-[24rem] rounded-full bg-[#1a5c3e]/30 blur-[90px]" />
      <div className="absolute left-1/2 top-[10%] h-72 w-72 -translate-x-1/2 rounded-full bg-[#f5e6a8]/06 blur-[80px]" />
      <svg
        className="absolute left-1/2 top-1/2 h-[min(120vh,900px)] w-auto min-w-[130%] -translate-x-1/2 -translate-y-[40%] text-white opacity-[0.08] sm:w-[118%]"
        viewBox="0 0 420 760"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <path
          d="M40 52h340v656H40V52Zm170 0v656M52 394h316"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <rect x="100" y="120" width="220" height="516" rx="2" stroke="currentColor" strokeWidth="3" fill="none" />
        <line x1="210" y1="378" x2="210" y2="394" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
      </svg>
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(90deg, white 1px, transparent 1px), linear-gradient(white 1px, transparent 1px)",
          backgroundSize: "56px 56px"
        }}
      />
      <div className="absolute right-[10%] top-[20%] opacity-[0.06]">
        <TennisBall className="h-28 w-28 text-[#eeff88] sm:h-36 sm:w-36" strokeWidth={1.5} />
      </div>
      <div className="absolute bottom-[24%] left-[8%] opacity-[0.05]">
        <TennisBall className="h-24 w-24 text-[#ccee33] sm:h-32 sm:w-32" strokeWidth={1.5} />
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#060a08] text-neutral-100">
      <CourtBackdrop />
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#060a08]/20 via-transparent to-[#060a08]"
        aria-hidden
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-5 pb-16 pt-8 sm:px-8 lg:pb-24 lg:pt-12">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <TennisBall className="h-7 w-7 text-[#ccee33] sm:h-8 sm:w-8" strokeWidth={2} />
            <span>
              Ace <span className="text-neutral-500">&middot;</span>{" "}
              <span className="font-normal text-neutral-400">tennis coach</span>
            </span>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            <Link
              href="/login"
              className="rounded-xl border border-white/15 px-4 py-2 font-medium text-neutral-200 transition hover:bg-white/[0.06]"
            >
              Connexion
            </Link>
            <Link
              href="/signup"
              className="rounded-xl bg-[#e67e22] px-4 py-2 font-semibold text-white shadow-[0_6px_20px_rgba(230,126,34,0.25)] transition hover:brightness-110"
            >
              Créer ton compte
            </Link>
          </nav>
        </header>

        <main className="mt-12 flex flex-1 flex-col gap-14 lg:mt-16 lg:flex-row lg:items-center lg:gap-16">
          <section className="flex-1 text-center lg:max-w-xl lg:text-left">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium leading-snug tracking-normal text-[#dfe9a8] sm:px-3.5">
              Un coach tennis, même en amateur
            </p>
            <h1 className="text-balance text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl lg:text-[3.25rem]">
              Prépare chaque match comme un <span className="text-[#e67e22]">pro</span>
            </h1>
            <p className="mx-auto mt-5 max-w-lg text-pretty text-lg leading-relaxed text-neutral-400 lg:mx-0 lg:text-xl">
              Ace t&apos;aide à définir une stratégie de match, préparer un programme d&apos;entraînement,
              débriefer après le match pour atteindre tes objectifs.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:justify-center lg:justify-start">
              <Link
                href="/signup"
                className="inline-flex w-full min-w-[200px] justify-center rounded-2xl bg-[#e67e22] px-8 py-3.5 text-center text-base font-semibold text-white shadow-[0_8px_28px_rgba(230,126,34,0.3)] transition hover:brightness-110 sm:w-auto"
              >
                Créer ton compte
              </Link>
              <Link
                href="/login"
                className="inline-flex w-full justify-center rounded-2xl border border-white/20 px-8 py-3.5 text-center text-base font-medium text-neutral-200 transition hover:bg-white/[0.06] sm:w-auto"
              >
                J&apos;ai déjà un compte
              </Link>
            </div>
          </section>

          <section className="flex flex-1 flex-col gap-3 sm:gap-4">
            <p className="text-center text-sm font-semibold text-neutral-500 lg:text-left">
              Les 3 clés d&apos;Ace
            </p>
            <ul className="space-y-3">
              <li className="flex gap-4 rounded-2xl border border-white/[0.08] bg-black/25 p-4 backdrop-blur-sm sm:p-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e67e22]/15">
                  <CalendarDays className="h-5 w-5 text-[#e67e22]" aria-hidden />
                </div>
                <div className="flex items-center">
                  <h2 className="font-semibold text-white">Un plan pour chaque match</h2>
                </div>
              </li>
              <li className="flex gap-4 rounded-2xl border border-white/[0.08] bg-black/25 p-4 backdrop-blur-sm sm:p-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e67e22]/15">
                  <Trophy className="h-5 w-5 text-[#e67e22]" aria-hidden />
                </div>
                <div className="flex items-center">
                  <h2 className="font-semibold text-white">Des progrès mesurables</h2>
                </div>
              </li>
              <li className="flex gap-4 rounded-2xl border border-white/[0.08] bg-black/25 p-4 backdrop-blur-sm sm:p-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e67e22]/15">
                  <MessageCircle className="h-5 w-5 text-[#e67e22]" aria-hidden />
                </div>
                <div className="flex items-center">
                  <h2 className="font-semibold text-white">Un entraîneur à ta disposition</h2>
                </div>
              </li>
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}
