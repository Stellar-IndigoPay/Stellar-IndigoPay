import React from "react";

interface MockLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
  [key: string]: any;
}

export default function Link({ href, children, className, ...props }: MockLinkProps) {
  return (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  );
}
