-- Seuil « en ordre » : pourcentage minimum des frais exigibles payé pour suivre les cours (50 % par défaut).
ALTER TABLE "schools" ADD COLUMN     "eligibility_threshold" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "schools" ADD CONSTRAINT "schools_eligibility_threshold_check" CHECK ("eligibility_threshold" BETWEEN 0 AND 100);
