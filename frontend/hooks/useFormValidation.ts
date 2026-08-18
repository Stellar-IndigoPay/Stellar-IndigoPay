import { useState } from "react";
import { z } from "zod";

export function useFormValidation<T extends z.ZodTypeAny>(schema: T) {
  type FormData = z.infer<T>;
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});

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
        fieldErrors[key] = issue.message as any;
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
