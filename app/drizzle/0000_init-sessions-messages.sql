CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`intent` text,
	`confidence` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New task' NOT NULL,
	`workspace_path` text NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`provider` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
