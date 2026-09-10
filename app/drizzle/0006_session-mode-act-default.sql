PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New task' NOT NULL,
	`workspace_path` text NOT NULL,
	`mode` text DEFAULT 'act' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`provider` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "title", "workspace_path", "mode", "status", "provider", "model", "created_at", "updated_at") SELECT "id", "title", "workspace_path", "mode", "status", "provider", "model", "created_at", "updated_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
UPDATE `sessions` SET `mode` = 'act' WHERE `mode` IS NULL OR `mode` NOT IN ('plan', 'act');