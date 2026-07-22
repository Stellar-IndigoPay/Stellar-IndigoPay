import { renderHook, act } from "@testing-library/react";
import { z } from "zod";
import { useFormValidation } from "../../hooks/useFormValidation";

describe("useFormValidation Hook", () => {
  const schema = z.object({
    username: z.string().min(3, "Too short"),
    email: z.string().email("Invalid email"),
  });

  test("initializes with empty errors and isValid true", () => {
    const { result } = renderHook(() => useFormValidation(schema));

    expect(result.current.errors).toEqual({});
    expect(result.current.isValid).toBe(true);
  });

  test("validates valid data correctly", () => {
    const { result } = renderHook(() => useFormValidation(schema));

    act(() => {
      const isValid = result.current.validate({
        username: "johndoe",
        email: "john@example.com",
      });
      expect(isValid).toBe(true);
    });

    expect(result.current.errors).toEqual({});
    expect(result.current.isValid).toBe(true);
  });

  test("validates invalid data correctly and populates errors", () => {
    const { result } = renderHook(() => useFormValidation(schema));

    act(() => {
      const isValid = result.current.validate({
        username: "jo",
        email: "not-an-email",
      });
      expect(isValid).toBe(false);
    });

    expect(result.current.errors).toEqual({
      username: "Too short",
      email: "Invalid email",
    });
    expect(result.current.isValid).toBe(false);
  });

  test("clears specific field errors", () => {
    const { result } = renderHook(() => useFormValidation(schema));

    act(() => {
      result.current.validate({
        username: "jo",
        email: "not-an-email",
      });
    });

    expect(result.current.errors.username).toBe("Too short");

    act(() => {
      result.current.clearField("username");
    });

    expect(result.current.errors.username).toBeUndefined();
    expect(result.current.errors.email).toBe("Invalid email");
    expect(result.current.isValid).toBe(false);
  });

  test("allows setting manual errors via setErrors", () => {
    const { result } = renderHook(() => useFormValidation(schema));

    act(() => {
      result.current.setErrors({
        username: "Server validation failed",
      });
    });

    expect(result.current.errors).toEqual({
      username: "Server validation failed",
    });
    expect(result.current.isValid).toBe(false);
  });
});
