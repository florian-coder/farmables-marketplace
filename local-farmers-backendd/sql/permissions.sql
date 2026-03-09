CREATE TABLE IF NOT EXISTS public.permission (
  id bigint PRIMARY KEY REFERENCES public.farmers(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  fruits_and_veggies boolean DEFAULT false,
  honey boolean DEFAULT false,
  eggs boolean DEFAULT false
);

CREATE OR REPLACE FUNCTION handle_new_farmer_permission() 
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.permission (id, fruits_and_veggies, honey, eggs)
  VALUES (NEW.id, false, false, false)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_farmer_created ON public.farmers;
CREATE TRIGGER on_farmer_created
AFTER INSERT ON public.farmers
FOR EACH ROW EXECUTE FUNCTION handle_new_farmer_permission();
