import { forwardRef, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";

// ── Shared props across all field types ───────────────────────────────────────
interface FormFieldBaseProps {
  label: string;
  error?: string;
  hint?: string;
  id?: string;
  required?: boolean;
  /** Content rendered after the input element (e.g. checkboxes, inline buttons) */
  children?: ReactNode;
}

// ── Input ─────────────────────────────────────────────────────────────────────
interface FormFieldInputProps
  extends FormFieldBaseProps,
    InputHTMLAttributes<HTMLInputElement> {
  as?: "input";
}

// ── Textarea ──────────────────────────────────────────────────────────────────
interface FormFieldTextareaProps
  extends FormFieldBaseProps,
    TextareaHTMLAttributes<HTMLTextAreaElement> {
  as: "textarea";
}

// ── Select ────────────────────────────────────────────────────────────────────
interface FormFieldSelectProps
  extends FormFieldBaseProps,
    SelectHTMLAttributes<HTMLSelectElement> {
  as: "select";
  children: React.ReactNode;
}

type FormFieldProps =
  | FormFieldInputProps
  | FormFieldTextareaProps
  | FormFieldSelectProps;

/**
 * Reusable form field wrapper that renders a label, the appropriate input
 * element, an optional hint (shown only when there's no error), and an
 * error message with proper aria attributes for accessibility.
 */
const FormField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  FormFieldProps
>((props, ref) => {
  const {
    label,
    error,
    hint,
    id,
    as = "input",
    required,
    className = "",
    ...inputProps
  } = props;

  const fieldId = id ?? (inputProps as any).name ?? label;

  const baseClasses =
    "w-full rounded-lg border bg-white px-4 py-2.5 text-sm text-[#0F172A] dark:bg-[#14142D] dark:text-[#E2E8F0] placeholder:text-[#94A3B8] dark:placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-offset-0 transition-colors font-body";
  const normalBorder =
    "border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] focus:border-[#4F46E5] dark:focus:border-[#818CF8] focus:ring-[#4F46E5]/20 dark:focus:ring-[#818CF8]/20";
  const errorBorder =
    "border-red-500 dark:border-red-400 focus:border-red-500 dark:focus:border-red-400 focus:ring-red-500/20";

  const inputClass = `${baseClasses} ${error ? errorBorder : normalBorder} ${className}`;

  // The error message id for aria-describedby
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const describedBy = [
    error ? errorId : null,
    hint && !error ? hintId : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

  const labelText = required ? `${label} *` : label;

  const renderInput = () => {
    if (as === "textarea") {
      const { as: _, children, ...rest } = props as FormFieldTextareaProps;
      return (
        <>
          <textarea
            ref={ref as React.Ref<HTMLTextAreaElement>}
            id={fieldId}
            className={`${inputClass} min-h-[100px] resize-y`}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            {...rest}
          />
          {children}
        </>
      );
    }

    if (as === "select") {
      const { as: _, children, ...rest } = props as FormFieldSelectProps;
      return (
        <select
          ref={ref as React.Ref<HTMLSelectElement>}
          id={fieldId}
          className={inputClass}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          {...rest}
        >
          {children}
        </select>
      );
    }

    // Default: input
    const { as: _, children, ...rest } = props as FormFieldInputProps;
    return (
      <>
        <input
          ref={ref as React.Ref<HTMLInputElement>}
          id={fieldId}
          className={inputClass}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          {...rest}
        />
        {children}
      </>
    );
  };

  return (
    <div className="space-y-1">
      <label
        htmlFor={fieldId}
        className="block text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] font-body"
      >
        {labelText}
      </label>
      {renderInput()}
      {hint && !error && (
        <p id={hintId} className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          className="text-xs text-red-600 dark:text-red-400 font-body"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
});

FormField.displayName = "FormField";

export default FormField;
