import { useState } from "react";
import { z } from "zod";
import { useI18n } from "@/lib/i18n";

export function useFormValidation<T extends z.ZodTypeAny>(schema: T) {
  type FormData = z.infer<T>;
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const { t } = useI18n();

  // Custom issues from shared/validation.js carry `params.key`, a
  // validation.* i18n key (Issue #90); everything else (zod's own
  // .email()/.url() messages, or schemas not yet migrated) falls back
  // to the message zod already generated.
  function resolveMessage(issue: z.ZodIssue): string {
    const params = (issue as { params?: Record<string, unknown> }).params;
    if (params && typeof params.key === "string") {
      return t(`validation.${params.key}`, params as Record<string, string | number>);
    }
    return issue.message;
  }

  function validate(data: FormData): boolean {
    const result = schema.safeParse(data);
    if (result.success) {
      setErrors({});
      return true;
    }

    const fieldErrors: Partial<Record<keyof FormData, string>> = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0] as keyof FormData;
      if (key !== undefined) {
        fieldErrors[key] = resolveMessage(issue) as any;
      }
    }
    setErrors(fieldErrors);
    return false;
  }

  function clearField(field: keyof FormData) {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  const isValid = Object.keys(errors).length === 0;

  return {
    errors,
    setErrors,
    validate,
    clearField,
    isValid,
  };
}
