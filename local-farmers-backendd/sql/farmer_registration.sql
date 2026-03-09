CREATE OR REPLACE FUNCTION register_farmer(
  p_username text,
  p_email text,
  p_password text,
  p_user_type text,
  p_docs jsonb
) RETURNS jsonb AS $$
DECLARE
  v_user_id bigint;
BEGIN
  -- 1. Insert user and get the auto-generated bigserial ID
  INSERT INTO public.users (username, email, password, user_type)
  VALUES (p_username, p_email, p_password, p_user_type)
  RETURNING id INTO v_user_id;

  -- 2. Insert farmer profile, forcing the same ID
  INSERT INTO public.farmers (id, "farm name", "display name", email)
  OVERRIDING SYSTEM VALUE
  VALUES (v_user_id, p_username || '''s Farm', p_username, p_email);

  -- 3. Insert documents, forcing the same ID
  INSERT INTO public.farmer_docs (
    id,
    atestat_prod,
    atestat_prod_2,
    certificat_register,
    cui,
    carnet_commerce,
    sanitary_doc_egg,
    sanitary_doc_honey
  ) 
  OVERRIDING SYSTEM VALUE
  VALUES (
    v_user_id,
    p_docs->>'atestat_prod',
    p_docs->>'atestat_prod_2',
    p_docs->>'certificat_register',
    p_docs->>'cui',
    p_docs->>'carnet_commerce',
    p_docs->>'sanitary_doc_egg',
    p_docs->>'sanitary_doc_honey'
  );

  RETURN jsonb_build_object(
    'id', v_user_id,
    'username', p_username,
    'user_type', p_user_type
  );
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
