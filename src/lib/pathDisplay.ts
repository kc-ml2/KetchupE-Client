export const getPathLeafName = (pathValue: string): string => {
  const trimmedPath = pathValue.trim();
  const withoutTrailingSeparator = trimmedPath.replace(/[\\/]+$/, "");
  const leafName = withoutTrailingSeparator.split(/[\\/]/).pop();

  return leafName || pathValue;
};
