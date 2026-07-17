import { LOGO_SRC, SITE_NAME } from "./siteConfig";

const SIZE_CLASS = {
  sm: "itc-logo-img-sm",
  md: "itc-logo-img-md",
  lg: "itc-logo-img-lg",
};

/** INSPIRE_TECH brand mark — use with optional wordmark in parent. */
export default function Logo({ size = "md", className = "", alt = SITE_NAME }) {
  return (
    <img
      src={LOGO_SRC}
      alt={alt}
      className={`itc-logo-img ${SIZE_CLASS[size] || SIZE_CLASS.md}${className ? ` ${className}` : ""}`}
      draggable={false}
    />
  );
}

/** Logo + INSPIRE_TECH wordmark (matches supplied brand lockup). */
export function LogoLockup({ size = "md", showWordmark = true, className = "" }) {
  return (
    <span className={`itc-logo-lockup${className ? ` ${className}` : ""}`}>
      <Logo size={size} alt="" />
      {showWordmark && <span className="itc-logo-wordmark">INSPIRE_TECH</span>}
    </span>
  );
}
