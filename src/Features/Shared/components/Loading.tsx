function Loading({ comment }: { comment: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen w-full">
      <div className="flex flex-col items-center">
        <div className="w-10 h-10 border-4 border-primary-200 border-t-primary rounded-full animate-spin"></div>
        <p className="mt-4 text-700">{comment}</p>
      </div>
    </div>
  );
}

export default Loading;