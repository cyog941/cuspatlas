-- C12 insurer portion (closeout B; synthetic engineering method c12-insurer-portion-v1,
-- recommended-pending-billing-approval). An estimate stores, at generation, the insurer/patient
-- portion computed from B5 structured benefits and B9 allowances together with every input's source
-- and freshness, or the reason it could not be computed (the patient range is then the fallback).
-- The value is part of the append-only estimate row; reads re-check input freshness.
ALTER TABLE cuspatlas.clinical_estimates ADD COLUMN insurer_estimate jsonb;
ALTER TABLE cuspatlas.clinical_estimates ADD CONSTRAINT clinical_estimates_insurer_estimate_shape
  CHECK (insurer_estimate IS NULL OR (jsonb_typeof(insurer_estimate) = 'object'
         AND insurer_estimate ->> 'kind' IN ('estimated', 'unavailable')
         AND insurer_estimate -> 'notAGuarantee' = 'true'::jsonb));
