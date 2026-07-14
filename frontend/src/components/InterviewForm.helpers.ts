/** Return answered questions in their request's canonical order. */
export function orderInterviewAnswers<T>(
  questions: ReadonlyArray<{ id: string }>,
  answers: ReadonlyMap<string, T>,
): T[] {
  return questions.flatMap((question) => {
    const answer = answers.get(question.id);
    return answer === undefined ? [] : [answer];
  });
}
