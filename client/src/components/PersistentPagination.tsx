import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type PersistentPaginationOptions = {
  storageKey: string;
  pageSize?: number;
  isReady?: boolean;
};

export type PersistentPaginationState<T> = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  startItem: number;
  endItem: number;
  items: T[];
  setPage: (page: number) => void;
  nextPage: () => void;
  previousPage: () => void;
};

export type PersistentPageRequestState = {
  page: number;
  setPage: (page: number) => void;
};

function readStoredPage(storageKey: string) {
  if (typeof window === "undefined") return 1;
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  } catch {
    return 1;
  }
}

function writeStoredPage(storageKey: string, page: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(page));
  } catch {
    // Pagination still works without localStorage in restricted browsers.
  }
}

export function usePersistentPageRequest(storageKey: string): PersistentPageRequestState {
  const [page, setStoredPage] = useState(() => readStoredPage(storageKey));

  useEffect(() => {
    setStoredPage(readStoredPage(storageKey));
  }, [storageKey]);

  const setPage = useCallback((nextPage: number) => {
    const normalized = Math.max(1, Math.floor(Number(nextPage) || 1));
    setStoredPage(normalized);
    writeStoredPage(storageKey, normalized);
  }, [storageKey]);

  return { page, setPage };
}

export function useServerPagination<T>(
  items: T[],
  totalItems: number,
  request: PersistentPageRequestState,
  { pageSize = 12, isReady = true }: Omit<PersistentPaginationOptions, "storageKey"> = {},
): PersistentPaginationState<T> {
  const normalizedTotal = Math.max(0, Math.floor(Number(totalItems) || 0));
  const totalPages = isReady ? Math.max(1, Math.ceil(normalizedTotal / pageSize)) : Math.max(1, request.page);
  const currentPage = isReady ? Math.min(Math.max(request.page, 1), totalPages) : Math.max(request.page, 1);

  useEffect(() => {
    if (!isReady || request.page === currentPage) return;
    request.setPage(currentPage);
  }, [currentPage, isReady, request]);

  const setPage = (nextPage: number) => {
    const normalized = Math.floor(Number(nextPage) || 1);
    request.setPage(Math.min(Math.max(normalized, 1), totalPages));
  };
  const startItem = normalizedTotal === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = normalizedTotal === 0 ? 0 : Math.min(normalizedTotal, currentPage * pageSize);

  return {
    currentPage,
    totalPages,
    totalItems: normalizedTotal,
    pageSize,
    startItem,
    endItem,
    items: isReady ? items : [],
    setPage,
    nextPage: () => setPage(currentPage + 1),
    previousPage: () => setPage(currentPage - 1),
  };
}

function getPageWindow(currentPage: number, totalPages: number) {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, currentPage]);
  if (currentPage > 2) pages.add(currentPage - 1);
  if (currentPage < totalPages - 1) pages.add(currentPage + 1);
  return Array.from(pages).sort((a, b) => a - b);
}

export function PersistentPagination<T>({
  pagination,
  itemName = "项",
}: {
  pagination: PersistentPaginationState<T>;
  itemName?: string;
}) {
  if (pagination.totalItems <= pagination.pageSize) return null;
  const pages = getPageWindow(pagination.currentPage, pagination.totalPages);

  /*
    照参考站（Vexo 模型广场）表格下方的分页：左边一句灰字，右边一排 32px 高、控件圆角、
    一圈弱线的白底小按钮，当前页是天蓝实底白字。不再给整条分页套一个描边框 —— 它坐在
    表格卡下面，再框一次就是「线画了两次」。
  */
  const pageButton = "h-8 min-w-8 rounded-[var(--fx-radius-control)] px-2.5 text-[13px]";
  return (
    <div className="flex flex-col gap-3 px-1 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        第 {pagination.currentPage} / {pagination.totalPages} 页，显示 {pagination.startItem}-{pagination.endItem}，共 {pagination.totalItems} {itemName}
      </div>
      <div className="flex items-center justify-between gap-1.5 sm:justify-end">
        <Button
          variant="outline"
          size="sm"
          className={`${pageButton} gap-1`}
          disabled={pagination.currentPage <= 1}
          onClick={pagination.previousPage}
        >
          <ChevronLeft className="h-4 w-4" />
          上一页
        </Button>
        <div className="hidden items-center gap-1.5 sm:flex">
          {pages.map((page, index) => {
            const previous = pages[index - 1];
            const hasGap = previous && page - previous > 1;
            return (
              <div key={page} className="flex items-center gap-1.5">
                {hasGap && <span className="px-1 text-xs text-muted-foreground">...</span>}
                <Button
                  variant={page === pagination.currentPage ? "default" : "outline"}
                  size="sm"
                  className={pageButton}
                  aria-current={page === pagination.currentPage ? "page" : undefined}
                  onClick={() => pagination.setPage(page)}
                >
                  {page}
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          className={`${pageButton} gap-1`}
          disabled={pagination.currentPage >= pagination.totalPages}
          onClick={pagination.nextPage}
        >
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
