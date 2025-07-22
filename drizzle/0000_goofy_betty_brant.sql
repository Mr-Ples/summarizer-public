CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`originalName` text NOT NULL,
	`fileSize` integer NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`currentStep` text DEFAULT 'uploaded',
	`progress` integer DEFAULT 0,
	`statusMessage` text,
	`summary` text,
	`tableOfContents` text,
	`tocGeneratedAt` integer,
	`outlineApprovedAt` integer,
	`processingData` text,
	`createdAt` integer NOT NULL,
	`completedAt` integer,
	`errorMessage` text,
	`pdfR2Key` text,
	`pdfTitle` text,
	`pdfAuthor` text
);
--> statement-breakpoint
CREATE TABLE `sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`documentId` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`startPage` integer NOT NULL,
	`endPage` integer NOT NULL,
	`sectionNumber` integer NOT NULL,
	`pdfPath` text,
	FOREIGN KEY (`documentId`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
