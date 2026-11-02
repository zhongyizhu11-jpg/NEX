import { Button } from "@/components/ui/button";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends Component<Props, State> {
  public override state: State = { hasError: false };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-svh items-center justify-center bg-background p-4">
          <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
            <h1 className="mb-3 text-xl font-semibold text-foreground">页面暂时无法显示</h1>
            <p className="mb-5 break-words text-sm leading-6 text-muted-foreground">
              {this.state.error?.message || "发生了未知错误"}
            </p>
            <Button
              onClick={() => window.location.reload()}
            >
              刷新页面
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
