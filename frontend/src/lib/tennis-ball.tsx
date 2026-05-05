import type { LucideProps } from "lucide-react";
import { forwardRef } from "react";

/** Balle de tennis (tracé @lucide/lab) — même grammage de trait que les icônes Lucide. */
export const TennisBall = forwardRef<SVGSVGElement, LucideProps>(
  ({ className, strokeWidth = 2, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...props}
    >
      <path d="M2 12c5.5 0 10-4.5 10-10" />
      <circle cx="12" cy="12" r="10" />
      <path d="M22 12c-5.5 0-10 4.5-10 10" />
    </svg>
  )
);

TennisBall.displayName = "TennisBall";
