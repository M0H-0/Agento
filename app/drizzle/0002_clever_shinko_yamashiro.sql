CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
