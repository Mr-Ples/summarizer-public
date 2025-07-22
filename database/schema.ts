import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: integer().primaryKey({ autoIncrement: true }),
  originalName: text().notNull(),
  fileSize: integer().notNull(),
  status: text({ enum: ['processing', 'completed', 'failed', 'awaiting_outline_approval', 'awaiting_summary_approval'] }).notNull().default('processing'),
  currentStep: text().default('uploaded'), // Current processing step
  progress: integer().default(0), // Progress percentage (0-100)
  statusMessage: text(), // Detailed status message for user
  summary: text(), // Complete document summary
  tableOfContents: text(), // JSON string of table of contents
  tocGeneratedAt: integer({ mode: 'timestamp' }), // When TOC was generated
  outlineApprovedAt: integer({ mode: 'timestamp' }), // When user approved the outline
  processingData: text(), // JSON string of processing data for continuation after approval
  createdAt: integer({ mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  completedAt: integer({ mode: 'timestamp' }),
  errorMessage: text(),
  pdfR2Key: text(), // R2 key or URL for the original PDF
  // PDF metadata fields
  pdfTitle: text(), // PDF title from metadata
  pdfAuthor: text(), // PDF author from metadata
});

export const sections = sqliteTable("sections", {
  id: integer().primaryKey({ autoIncrement: true }),
  documentId: integer().notNull().references(() => documents.id),
  title: text().notNull(),
  summary: text().notNull(),
  startPage: integer().notNull(),
  endPage: integer().notNull(),
  sectionNumber: integer().notNull(),
  pdfPath: text(), // Path to the section PDF file (for cloud storage URL)
});

// Removed processingSteps table - only storing final results
