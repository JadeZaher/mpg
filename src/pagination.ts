/**
 * Pagination utility.
 *
 * Uniform pagination shape across all paginated operations:
 *   - search results (nodes)
 *   - --mp-list (stashes)
 *   - --mp-get (nodes within a stash)
 *
 * Pagination is opt-in via --page N. The default behavior is
 * "give me everything" (backwards compatible). When --page is set,
 * we slice the full result set and emit metadata.
 */

export interface PaginationOptions {
  page?: number;
  pageSize?: number;
  all?: boolean;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination?: PaginationMeta;
}

/** Resolve effective pagination options, applying defaults. */
export function resolvePagination(opts: PaginationOptions): {
  enabled: boolean;
  page: number;
  pageSize: number;
} {
  const enabled = opts.all ? false : (opts.page !== undefined && opts.page > 0);
  const page = enabled ? (opts.page ?? 1) : 1;
  const pageSize = opts.pageSize ?? 10;
  return { enabled, page, pageSize };
}

/** Apply pagination to an array, returning the slice and metadata. */
export function paginate<T>(items: T[], opts: PaginationOptions): PaginatedResult<T> {
  const { enabled, page, pageSize } = resolvePagination(opts);
  if (!enabled) {
    return { items };
  }
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  // Clamp page to valid range.
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = start + pageSize;
  const slice = items.slice(start, end);
  return {
    items: slice,
    pagination: {
      page: clampedPage,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: clampedPage < totalPages,
      has_prev: clampedPage > 1,
    },
  };
}

/** Render pagination metadata as a compact annotation for the LLM format. */
export function paginationAnnotation(meta: PaginationMeta | undefined): string {
  if (!meta) return "";
  return ` page=${meta.page} of ${meta.total_pages} page_size=${meta.page_size} total_items=${meta.total_items}`;
}

/** Render pagination metadata for the text format. */
export function paginationTextNote(meta: PaginationMeta | undefined): string {
  if (!meta) return "";
  const nav = [
    meta.has_prev ? "<- prev" : null,
    `page ${meta.page} of ${meta.total_pages}`,
    meta.has_next ? "next ->" : null,
  ].filter(Boolean).join("  ");
  // The caller can wrap this in color codes if desired.
  return `[${nav} | ${meta.total_items} items | page_size=${meta.page_size}]`;
}
