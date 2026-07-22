import React from "react";

interface FormFieldProps {
  name: string;
  label: string;
  error?: string;
  helper?: string;
  required?: boolean;
  children: React.ReactNode;
}

export default function FormField({
  name,
  label,
  error,
  helper,
  required,
  children,
}: FormFieldProps) {
  const errorId = `${name}-error`;
  const helperId = `${name}-helper`;

  const describedByParts: string[] = [];
  if (error) {
    describedByParts.push(errorId);
  } else if (helper) {
    describedByParts.push(helperId);
  }
  const ariaDescribedBy = describedByParts.length > 0 ? describedByParts.join(" ") : undefined;

  // Function to recursively inject aria attributes to input/select/textarea elements
  const injectAriaAttributes = (node: React.ReactNode): React.ReactNode => {
    if (!React.isValidElement(node)) {
      return node;
    }

    const type = node.type as any;
    const isInputOrSelectOrTextArea =
      typeof type === "string" &&
      ["input", "select", "textarea"].includes(type);

    if (isInputOrSelectOrTextArea) {
      return React.cloneElement(node, {
        id: node.props.id || name,
        "aria-describedby": ariaDescribedBy,
        "aria-invalid": error ? "true" : "false",
      } as any);
    }

    if (node.props && node.props.children) {
      return React.cloneElement(node, {
        children: React.Children.map(node.props.children, injectAriaAttributes),
      } as any);
    }

    return node;
  };

  const renderedChildren = React.Children.map(children, injectAriaAttributes);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="label cursor-pointer">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {renderedChildren}
      {helper && !error && (
        <p id={helperId} className="text-xs text-[#8aaa8a] font-body">
          {helper}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-red-500 font-body" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
