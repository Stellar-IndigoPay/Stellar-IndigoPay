import { render, screen } from "@testing-library/react";
import React from "react";
import FormField from "../../components/FormField";

describe("FormField", () => {
  test("renders label and children input correctly", () => {
    render(
      <FormField name="username" label="Username">
        <input type="text" />
      </FormField>
    );

    expect(screen.getByLabelText("Username")).toBeInTheDocument();
  });

  test("displays helper text and links via aria-describedby when no error", () => {
    render(
      <FormField name="username" label="Username" helper="Enter your unique handle">
        <input type="text" />
      </FormField>
    );

    const helperText = screen.getByText("Enter your unique handle");
    expect(helperText).toBeInTheDocument();
    expect(helperText.id).toBe("username-helper");

    const input = screen.getByLabelText("Username");
    expect(input).toHaveAttribute("aria-describedby", "username-helper");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  test("displays error message, hides helper text, and sets aria-invalid when error exists", () => {
    render(
      <FormField
        name="username"
        label="Username"
        helper="Enter your unique handle"
        error="Username is already taken"
      >
        <input type="text" />
      </FormField>
    );

    const errorMsg = screen.getByText("Username is already taken");
    expect(errorMsg).toBeInTheDocument();
    expect(errorMsg.id).toBe("username-error");

    expect(screen.queryByText("Enter your unique handle")).not.toBeInTheDocument();

    const input = screen.getByLabelText("Username");
    expect(input).toHaveAttribute("aria-describedby", "username-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  test("supports rendering required indicator", () => {
    render(
      <FormField name="username" label="Username" required>
        <input type="text" />
      </FormField>
    );

    expect(screen.getByText("*")).toBeInTheDocument();
  });

  test("recursively injects accessibility attributes to nested inputs", () => {
    render(
      <FormField name="username" label="Username" error="Invalid handle">
        <div>
          <span>Wrapper</span>
          <input type="text" />
        </div>
      </FormField>
    );

    const input = screen.getByLabelText("Username");
    expect(input).toHaveAttribute("aria-describedby", "username-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});
