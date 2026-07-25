export type Category = {
  id: string;
  user_id: string;
  source: string;
  title: string | null;
  created_at: string;
};

export type Problem = {
  id: string;
  category_id: string;
  user_id: string;
  image_path: string;
  latex: string | null;
  text_content: string | null;
  created_at: string;
};
